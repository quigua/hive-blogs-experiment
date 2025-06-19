// netlify/functions/get-user-posts.js
const Redis = require('ioredis');
const fetch = require('node-fetch');

// Declare redisClient globally but do NOT initialize it here with 'new Redis()'
// The initialization happens inside the async handler.
let redisClient = null; 

// Helper function to check if a post is "old" (immutable)
function isOldPost(createdDate) {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    return new Date(createdDate) < sevenDaysAgo;
}

exports.handler = async (event, context) => {
    // Define the timeout for each invocation to ensure it applies
    const timeoutPromise = new Promise((resolve, reject) => {
        setTimeout(() => {
            reject(new Error('Function execution timed out before completing.'));
        }, 9000); // 9 seconds, a bit less than Netlify's timeout
    });

    try {
        // --- Redis initialization/re-use logic within the handler ---
        // All logic involving 'new Redis()' and 'redisClient.status' must be here.
        if (!redisClient || redisClient.status === 'end' || redisClient.status === 'wait') {
            console.log('[ioredis] Initializing or re-establishing Redis connection...');
            const redisUrl = process.env.UPSTASH_REDIS_URL;
            const redisPassword = process.env.UPSTASH_REDIS_PASSWORD;

            if (!redisUrl) {
                console.error("ERROR: UPSTASH_REDIS_URL is not configured.");
                return { statusCode: 500, body: JSON.stringify({ error: 'Missing Redis URL configuration.' }) };
            }
            if (!redisPassword) {
                console.error("ERROR: UPSTASH_REDIS_PASSWORD is not configured.");
                return { statusCode: 500, body: JSON.stringify({ error: 'Missing Redis Password configuration.' }) };
            }

            redisClient = new Redis(redisUrl, { password: redisPassword, tls: {} });
            
            // Attach listeners only once per new instance to prevent duplicates on 'warm' reuses.
            if (!redisClient.__listenersAttached) {
                redisClient.on('error', (err) => console.error('[ioredis] Connection or operation error:', err.message, err.code, err.address));
                redisClient.on('connect', () => console.log('[ioredis] Connected to Redis!'));
                redisClient.on('reconnecting', () => console.warn('[ioredis] Reconnecting to Redis...'));
                redisClient.on('end', () => { console.warn('[ioredis] Redis connection terminated. Resetting client.'); redisClient = null; });
                redisClient.__listenersAttached = true; // Mark that listeners have been attached
            }
        }
        // --- End of Redis logic ---

        const { username, limit, start_author, start_permlink, contentType = 'posts' } = event.queryStringParameters;
        const parsedLimit = parseInt(limit);

        if (!username || !parsedLimit) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing parameters: username or limit.' }) };
        }

        const hiveNodes = [
            'https://api.hive.blog',
            'https://api.deathwing.me',
            'https://api.pharesim.me'
        ];
        
        const cacheKey = `hive:${contentType}:${username}:${parsedLimit}:${start_author || 'null'}:${start_permlink || 'null'}`;
        
        let cachedResponse = null;
        try {
            cachedResponse = await Promise.race([redisClient.get(cacheKey), timeoutPromise]);
        } catch (redisErr) {
            console.error(`Error trying to get from Redis for ${cacheKey}:`, redisErr);
        }
       
        if (cachedResponse) {
            console.log(`Cache HIT for key: ${cacheKey}`);
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: cachedResponse,
            };
        }
        console.log(`Cache MISS for key: ${cacheKey}. Fetching from Hive.`);

        // --- KEY CHANGE: Adjust the maximum limit to 20 for Hive API ---
        // Hive API has a limit of 20. Request the maximum to have a good buffer.
        // const requestLimitToHive = Math.min(parsedLimit * 2 + 1, 20); // Ensures it never exceeds 20
        const requestLimitToHive = 20; // Simpler and safer for current needs

        const body = {
            jsonrpc: '2.0',
            id: 1,
            method: 'condenser_api.get_discussions_by_blog',
            params: [{
                tag: username,
                limit: requestLimitToHive, // This will be 20
                start_author: start_author || undefined,
                start_permlink: start_permlink || undefined,
            }],
        };

        let hiveResponse;
        let hiveError = null;

        for (const nodeUrl of hiveNodes) {
            console.log(`Attempting fetch with Hive node: ${nodeUrl}`);
            try {
                hiveResponse = await Promise.race([
                    fetch(nodeUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                    }),
                    timeoutPromise
                ]);

                if (hiveResponse.ok) {
                    hiveError = null;
                    break;
                } else {
                    const errorText = await hiveResponse.text();
                    hiveError = new Error(`Hive API error at ${nodeUrl}: ${hiveResponse.status} - ${errorText}`);
                    console.error(hiveError.message);
                }
            } catch (error) {
                hiveError = new Error(`Network error connecting to ${nodeUrl}: ${error.message}`);
                console.error(hiveError.message);
            }
        }

        if (!hiveResponse || !hiveResponse.ok) {
            throw hiveError || new Error('Could not connect to any Hive node.');
        }

        const hiveData = await hiveResponse.json();

        if (hiveData.error) {
            console.error('Hive error:', hiveData.error);
            return { statusCode: 500, body: JSON.stringify({ error: 'Hive API error', details: hiveData.error }) };
        }

        const allFetchedItems = hiveData.result || [];

        // --- Initial filtering for reblogs/posts ---
        const typeFilteredItems = allFetchedItems.filter(item => {
            if (contentType === 'posts') {
                return !item.reblogged_by || item.reblogged_by.length === 0;
            } else if (contentType === 'reblogs') {
                return item.reblogged_by && item.reblogged_by.length > 0;
            }
            return true; // If contentType is unknown, do not filter
        });

        // --- Remove the first element if it's the start_permlink (duplicate) ---
        let cleanedItems = typeFilteredItems;
        if (start_author && start_permlink && typeFilteredItems.length > 0 &&
            typeFilteredItems[0].author === start_author &&
            typeFilteredItems[0].permlink === start_permlink) {
            cleanedItems = typeFilteredItems.slice(1);
        }

        // --- Select only the posts/reblogs for the current page (parsedLimit) ---
        const currentBatchItems = cleanedItems.slice(0, parsedLimit);

        // --- Determine parameters for the next pagination ---
        // We look for the element immediately AFTER the last element
        // of the current batch *in the original unfiltered Hive list*, not the filtered one.
        let nextStartAuthor = null;
        let nextStartPermlink = null;
        let hasMore = true;

        if (currentBatchItems.length < parsedLimit) {
            // If the current batch is less than the limit, there are no more posts of this type.
            hasMore = false;
        } else {
            // If we have a full batch, we look for the next "start"
            // We want the permlink of the item that follows the last item in our batch *in the original list*
            const lastItemInCurrentBatch = currentBatchItems[currentBatchItems.length - 1];
            
            // Find the position of the last item in the current batch within the original list (allFetchedItems)
            const lastItemIndexInOriginal = allFetchedItems.findIndex(item => 
                item.author === lastItemInCurrentBatch.author && 
                item.permlink === lastItemInCurrentBatch.permlink
            );

            // If there's an item after the last item of our batch in the original list
            if (lastItemIndexInOriginal !== -1 && (lastItemIndexInOriginal + 1) < allFetchedItems.length) {
                const nextItem = allFetchedItems[lastItemIndexInOriginal + 1];
                nextStartAuthor = nextItem.author;
                nextStartPermlink = nextItem.permlink;
            } else {
                // No more elements in Hive's response beyond our current batch
                hasMore = false;
            }
        }

        // --- The final response includes the posts, and if there are more and the new start_author/permlink ---
        const responseData = {
            posts: currentBatchItems,
            nextStartAuthor: nextStartAuthor,
            nextStartPermlink: nextStartPermlink,
            hasMore: hasMore
        };
        
        // Only cache if there are posts
        if (currentBatchItems.length > 0) { 
            const cacheDuration = allFetchedItems.every(item => isOldPost(item.created)) ? 60 * 60 * 24 * 30 : 60 * 5;
            try {
                await Promise.race([redisClient.set(cacheKey, JSON.stringify(responseData), 'EX', cacheDuration), timeoutPromise]); 
                console.log(`Cache SET for key: ${cacheKey} (${contentType} filtered, duration: ${cacheDuration / 60} min).`);
            } catch (redisErr) {
                console.error(`Error trying to save to Redis ${cacheKey}:`, redisErr);
            }
        }
        
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(responseData),
        };

    } catch (error) {
        console.error('Error in get-user-posts function (caught):', error.message, error.stack);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Internal server error', details: error.message }),
        };
    } finally {
        // We do not call redisClient.quit() here.
    }
};