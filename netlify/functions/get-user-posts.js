// netlify/functions/get-user-posts.js
const Redis = require('ioredis');
const fetch = require('node-fetch');

let redisClient = null; 

// Helper function to check if a post is "old" (immutable)
function isOldPost(createdDate) {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    return new Date(createdDate) < sevenDaysAgo;
}

exports.handler = async (event, context) => {
    const timeoutPromise = new Promise((resolve, reject) => {
        setTimeout(() => {
            reject(new Error('Function execution timed out before completing.'));
        }, 9000); 
    });

    try {
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
            
            if (!redisClient.__listenersAttached) {
                redisClient.on('error', (err) => console.error('[ioredis] Connection or operation error:', err.message, err.code, err.address));
                redisClient.on('connect', () => console.log('[ioredis] Connected to Redis!'));
                redisClient.on('reconnecting', () => console.warn('[ioredis] Reconnecting to Redis...'));
                redisClient.on('end', () => { console.warn('[ioredis] Redis connection terminated. Resetting client.'); redisClient = null; });
                redisClient.__listenersAttached = true;
            }
        }

        const { username, limit, start_author, start_permlink } = event.queryStringParameters;
        const parsedLimit = parseInt(limit);

        if (!username || !parsedLimit) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing parameters: username or limit.' }) };
        }

        const hiveNodes = [
            'https://api.hive.blog',
            'https://api.deathwing.me',
            'https://api.pharesim.me'
        ];
        
        // La clave del caché ahora se enfoca solo en posts originales, ya que es el único tipo.
        const cacheKey = `hive:posts:${username}:${parsedLimit}:${start_author || 'null'}:${start_permlink || 'null'}`;
        
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

        // Siempre pedimos 20, el máximo, para tener un buen buffer de posts para filtrar.
        const requestLimitToHive = 20; 

        const body = {
            jsonrpc: '2.0',
            id: 1,
            method: 'condenser_api.get_discussions_by_blog',
            params: [{
                tag: username,
                limit: requestLimitToHive, 
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

        // --- FILTRADO EXCLUSIVO PARA POSTS ORIGINALES ---
        // Filtramos y quitamos el duplicado inicial si start_author/permlink fueron provistos.
        const originalPosts = [];
        let skippedInitialDuplicate = false;

        for (const item of allFetchedItems) {
            if (!skippedInitialDuplicate && start_author && start_permlink && 
                item.author === start_author && item.permlink === start_permlink) {
                skippedInitialDuplicate = true;
                continue; // Saltar este item duplicado
            }

            // Solo añadir si es un post original (no tiene reblogged_by o está vacío)
            if (!item.reblogged_by || item.reblogged_by.length === 0) {
                originalPosts.push(item);
            }
        }

        // Tomamos solo la cantidad necesaria para el lote actual (parsedLimit).
        const currentBatchItems = originalPosts.slice(0, parsedLimit);

        // --- DETERMINACIÓN DE LA PRÓXIMA PÁGINA (nextStartAuthor/Permlink) ---
        // La paginación se basa en los posts *originales* que hemos logrado filtrar.
        let nextStartAuthor = null;
        let nextStartPermlink = null;
        let hasMore = true;

        if (currentBatchItems.length < parsedLimit) {
            // Si el lote actual es menor que lo pedido, asumimos que no hay más posts originales.
            hasMore = false;
        } else {
            // Si tenemos un lote completo, el siguiente punto de inicio es el último de este lote filtrado.
            const lastItem = currentBatchItems[currentBatchItems.length - 1];
            nextStartAuthor = lastItem.author;
            nextStartPermlink = lastItem.permlink;
            hasMore = true;
        }
        
        const responseData = {
            posts: currentBatchItems,
            nextStartAuthor: nextStartAuthor,
            nextStartPermlink: nextStartPermlink,
            hasMore: hasMore
        };
        
        // Solo cacheamos si tenemos posts para devolver.
        if (currentBatchItems.length > 0) { 
            // La duración del caché dependerá de si los posts son viejos o nuevos.
            const cacheDuration = currentBatchItems.every(item => isOldPost(item.created)) ? 60 * 60 * 24 * 30 : 60 * 5;
            try {
                await Promise.race([redisClient.set(cacheKey, JSON.stringify(responseData), 'EX', cacheDuration), timeoutPromise]); 
                console.log(`Cache SET for key: ${cacheKey} (Posts originales, duración: ${cacheDuration / 60} min).`);
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
        // No llamamos a redisClient.quit() aquí.
    }
};