// netlify/functions/get-user-posts.js
const Redis = require('ioredis');
const fetch = require('node-fetch');

let redisClient = null;

function isOldPost(createdDate) {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    return new Date(createdDate) < sevenDaysAgo;
}

exports.handler = async (event, context) => {
    const timeoutPromise = new Promise((resolve, reject) => {
        setTimeout(() => {
            reject(new Error('Function execution timed out before completing.'));
        }, 25000); // 25 segundos
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

        const postsToFetchPerCall = 20;
        let collectedFilteredItems = [];
        let currentHiveStartAuthor = start_author;
        let currentHiveStartPermlink = start_permlink;
        let hiveHasMore = true;
        let maxIterations = 5;

        while (collectedFilteredItems.length < parsedLimit && hiveHasMore && maxIterations > 0) {
            maxIterations--;
            console.log(`[LOOP] Iteration ${5 - maxIterations}. Current filtered: ${collectedFilteredItems.length}. Fetching from Hive node...`);
            
            const body = {
                jsonrpc: '2.0',
                id: 1,
                method: 'condenser_api.get_discussions_by_blog',
                params: [{
                    tag: username,
                    limit: postsToFetchPerCall,
                    start_author: currentHiveStartAuthor || undefined,
                    start_permlink: currentHiveStartPermlink || undefined,
                }],
            };

            let hiveResponse;
            let hiveError = null;

            for (const nodeUrl of hiveNodes) {
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
                    console.error(error.message);
                }
            }

            if (!hiveResponse || !hiveResponse.ok) {
                console.error("Failed to fetch from any Hive node in loop. Breaking.");
                hiveHasMore = false;
                if (collectedFilteredItems.length === 0) {
                    throw hiveError || new Error('Could not connect to any Hive node during data collection.');
                }
                break;
            }

            const hiveData = await hiveResponse.json();

            if (hiveData.error) {
                console.error('Hive error during loop:', hiveData.error);
                hiveHasMore = false;
                if (collectedFilteredItems.length === 0) {
                    return { statusCode: 500, body: JSON.stringify({ error: 'Hive API error during data collection', details: hiveData.error }) };
                }
                break;
            }

            const currentFetchedItems = hiveData.result || [];
            if (currentFetchedItems.length === 0) {
                hiveHasMore = false;
                break;
            }

            // Actualizar la paginación para la siguiente llamada a Hive
            const lastItemFromHiveBatch = currentFetchedItems[currentFetchedItems.length - 1];
            currentHiveStartAuthor = lastItemFromHiveBatch.author;
            currentHiveStartPermlink = lastItemFromHiveBatch.permlink;
            
            // --- CORRECCIÓN AQUÍ: Declarar itemsToFilter siempre ---
            let itemsToFilter = currentFetchedItems;

            // Si es la primera llamada a la función (start_author/permlink están presentes)
            // Y el primer ítem devuelto por Hive es el mismo que el start_permlink,
            // entonces lo saltamos para evitar duplicados en el *primer* lote general.
            if (start_author && start_permlink && 
                currentFetchedItems[0].author === start_author && 
                currentFetchedItems[0].permlink === start_permlink) {
                 // Si collectedFilteredItems aún está vacío, significa que es el primer procesamiento del lote.
                 // Solo saltamos el duplicado si estamos en la primera iteración general de la función.
                 if (collectedFilteredItems.length === 0) {
                     itemsToFilter = currentFetchedItems.slice(1);
                 }
            }

            // Aplicar el filtro según el contentType
            for (const item of itemsToFilter) {
                if (contentType === 'posts') {
                    if (item.author === username && (!item.reblogged_by || item.reblogged_by.length === 0)) {
                        collectedFilteredItems.push(item);
                    }
                } else if (contentType === 'reblogs') {
                    if (item.reblogged_by && Array.isArray(item.reblogged_by) && item.reblogged_by.includes(username) && item.author !== username) {
                         collectedFilteredItems.push(item);
                    }
                }
            }
            
            if (currentFetchedItems.length < postsToFetchPerCall) {
                hiveHasMore = false;
            }
        } // Fin del bucle while

        const postsToSend = collectedFilteredItems.slice(0, parsedLimit);
        
        let finalHasMore = true; 
        if (collectedFilteredItems.length < parsedLimit && !hiveHasMore) {
            finalHasMore = false;
        } else if (collectedFilteredItems.length >= parsedLimit) {
             finalHasMore = true;
        } else if (collectedFilteredItems.length === 0 && !hiveHasMore) {
            finalHasMore = false;
        } else if (maxIterations === 0 && collectedFilteredItems.length < parsedLimit) {
            finalHasMore = true;
        }

        let nextClientStartAuthor = currentHiveStartAuthor;
        let nextClientStartPermlink = currentHiveStartPermlink;

        if (collectedFilteredItems.length === 0 && !hiveHasMore) {
            finalHasMore = false;
            nextClientStartAuthor = null;
            nextClientStartPermlink = null;
        } else if (postsToSend.length === 0 && finalHasMore) {
            // No se encontraron posts filtrados en este lote, pero Hive podría tener más,
            // por lo que el cliente debe reintentar con el mismo currentHiveStartAuthor/Permlink.
        } else if (postsToSend.length < parsedLimit && !hiveHasMore) {
            finalHasMore = false;
            nextClientStartAuthor = null;
            nextClientStartPermlink = null;
        }

        const responseData = {
            posts: postsToSend,
            nextStartAuthor: nextClientStartAuthor,
            nextStartPermlink: nextClientStartPermlink,
            hasMore: finalHasMore,
        };

        if (postsToSend.length > 0) {
            const cacheDuration = postsToSend.every(item => isOldPost(item.created)) ? 60 * 60 * 24 * 30 : 60 * 5;
            try {
                await Promise.race([redisClient.set(cacheKey, JSON.stringify(responseData), 'EX', cacheDuration), timeoutPromise]);
                console.log(`Cache SET for key: ${cacheKey} (${contentType} filtered, duration: ${cacheDuration / 60} min).`);
            } catch (redisErr) {
                console.error(`Error trying to save to Redis ${cacheKey}:`, redisErr);
            }
        } else if (!finalHasMore) {
             try {
                await Promise.race([redisClient.set(cacheKey, JSON.stringify(responseData), 'EX', 60 * 60 * 24 * 7), timeoutPromise]);
                console.log(`Cache SET for key: ${cacheKey} (No more items, duration: 7 days).`);
             } catch (redisErr) {
                console.error(`Error trying to save 'no more items' to Redis ${cacheKey}:`, redisErr);
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