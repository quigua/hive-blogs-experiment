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
        }, 25000); // Mantenemos el timeout para seguridad
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

        // *** CAMBIO CLAVE PARA PRUEBA: La clave de caché ahora es solo para 'reblogs' ***
        const cacheKey = `hive:reblogs_test:${username}:${parsedLimit}:${start_author || 'null'}:${start_permlink || 'null'}`;

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
        console.log(`Cache MISS for key: ${cacheKey}. Fetching from Hive (ONLY REBLOGS TEST).`);

        const postsToFetchPerCall = 20; // Límite de Hive

        const body = {
            jsonrpc: '2.0',
            id: 1,
            method: 'condenser_api.get_discussions_by_blog',
            params: [{
                tag: username,
                limit: postsToFetchPerCall,
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
                console.error(error.message);
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
        let filteredReblogs = [];

        // *** APLICAR SOLO EL FILTRO DE REBLOGS ***
        let itemsToFilter = allFetchedItems;

        // Si es la primera llamada a la función (start_author/permlink están presentes)
        // Y el primer ítem devuelto por Hive es el mismo que el start_permlink,
        // entonces lo saltamos para evitar duplicados.
        if (start_author && start_permlink && 
            allFetchedItems[0] && // Asegurarse de que el primer elemento existe
            allFetchedItems[0].author === start_author && 
            allFetchedItems[0].permlink === start_permlink) {
             itemsToFilter = allFetchedItems.slice(1);
        }

        for (const item of itemsToFilter) {
            // Filtro para reblogs: debe tener reblogged_by (y ser array), debe contener al username,
            // Y el autor de la publicación NO debe ser el username.
            if (item.reblogged_by && Array.isArray(item.reblogged_by) && item.reblogged_by.includes(username) && item.author !== username) {
                 filteredReblogs.push(item);
            }
        }
        
        // --- Simplificación de la paginación para esta prueba ---
        const postsToSend = filteredReblogs.slice(0, parsedLimit);
        let nextStartAuthor = null;
        let nextStartPermlink = null;
        let hasMore = false;

        // Si Hive nos dio un lote completo y aún podríamos tener más reblogs más allá de los filtrados
        if (allFetchedItems.length === postsToFetchPerCall && filteredReblogs.length > 0) {
            // El nextStart siempre apunta al último post BRUTO de la respuesta de Hive.
            // Esto es crucial para que Hive siga avanzando en el feed, incluso si los filtrados son pocos.
            const lastItemFromHive = allFetchedItems[allFetchedItems.length - 1];
            nextStartAuthor = lastItemFromHive.author;
            nextStartPermlink = lastItemFromHive.permlink;
            hasMore = true;
        } else if (allFetchedItems.length === postsToFetchPerCall && filteredReblogs.length === 0) {
            // Si Hive dio un lote completo pero no hubo reblogs, también hay que avanzar la paginación
            // para que el cliente pueda intentar una siguiente búsqueda más profunda.
            const lastItemFromHive = allFetchedItems[allFetchedItems.length - 1];
            nextStartAuthor = lastItemFromHive.author;
            nextStartPermlink = lastItemFromHive.permlink;
            hasMore = true; // Forzar hasMore para que el cliente siga pidiendo.
        }


        const responseData = {
            posts: postsToSend,
            nextStartAuthor: nextStartAuthor,
            nextStartPermlink: nextStartPermlink,
            hasMore: hasMore,
        };

        if (postsToSend.length > 0) {
            const cacheDuration = postsToSend.every(item => isOldPost(item.created)) ? 60 * 60 * 24 * 30 : 60 * 5;
            try {
                await Promise.race([redisClient.set(cacheKey, JSON.stringify(responseData), 'EX', cacheDuration), timeoutPromise]);
                console.log(`Cache SET for key: ${cacheKey} (reblogs filtered, duration: ${cacheDuration / 60} min).`);
            } catch (redisErr) {
                console.error(`Error trying to save to Redis ${cacheKey}:`, redisErr);
            }
        } else if (!hasMore) {
             try {
                await Promise.race([redisClient.set(cacheKey, JSON.stringify(responseData), 'EX', 60 * 60 * 24 * 7), timeoutPromise]);
                console.log(`Cache SET for key: ${cacheKey} (No more reblogs, duration: 7 days).`);
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