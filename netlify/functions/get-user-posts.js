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
        
        // La clave del caché ahora no incluye contentType para que el feed completo se cachee una vez.
        const cacheKey = `hive:feed:${username}:${start_author || 'null'}:${start_permlink || 'null'}`;
        
        let cachedResponse = null;
        try {
            cachedResponse = await Promise.race([redisClient.get(cacheKey), timeoutPromise]);
        } catch (redisErr) {
            console.error(`Error trying to get from Redis for ${cacheKey}:`, redisErr);
        }
       
        if (cachedResponse) {
            console.log(`Cache HIT for key: ${cacheKey}`);
            // Si hay caché, la devolvemos. La lógica de filtrado se hará en el cliente.
            const parsedCache = JSON.parse(cachedResponse);
            // Aplicamos el filtro si existe el parámetro contentType, sino devolvemos todo.
            const filteredPosts = parsedCache.posts.filter(item => {
                if (contentType === 'posts') {
                    return !item.reblogged_by || item.reblogged_by.length === 0;
                } else if (contentType === 'reblogs') {
                    return item.reblogged_by && item.reblogged_by.length > 0;
                }
                return true; // Si no hay contentType especificado, o es inválido, devolver todo.
            }).slice(0, parsedLimit); // Tomar solo el límite solicitado después de filtrar

            // La paginación real sigue el feed completo, no el filtrado.
            // Aseguramos que la respuesta del caché respete la estructura.
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    posts: filteredPosts, // Ahora solo la cantidad filtrada
                    nextStartAuthor: parsedCache.nextStartAuthor,
                    nextStartPermlink: parsedCache.nextStartPermlink,
                    hasMore: parsedCache.hasMore
                }),
            };
        }
        console.log(`Cache MISS for key: ${cacheKey}. Fetching from Hive.`);

        // Siempre pedimos 20, el máximo para obtener un buffer completo.
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

        // --- CALCULAR NEXT_START_AUTHOR/PERMLINK Y HAS_MORE PARA EL FEED COMPLETO ---
        // La paginación siempre se basa en el feed completo de Hive, sin filtrar aquí.
        let calculatedNextStartAuthor = null;
        let calculatedNextStartPermlink = null;
        let calculatedHasMore = true;

        if (allFetchedItems.length < requestLimitToHive || allFetchedItems.length === 0) {
            calculatedHasMore = false;
        } else {
            // El nextStart es el último elemento de la respuesta completa de Hive.
            const lastItem = allFetchedItems[allFetchedItems.length - 1];
            calculatedNextStartAuthor = lastItem.author;
            calculatedNextStartPermlink = lastItem.permlink;
        }

        // --- FILTRAR LOS POSTS PARA LA RESPUESTA AL CLIENTE ---
        // Aquí es donde filtramos lo que realmente enviamos al cliente.
        const finalFilteredPostsForClient = allFetchedItems.filter(item => {
            // Saltamos el duplicado inicial si start_author/permlink fueron provistos.
            // Esto solo se aplica a la primera ronda de filtrado antes de tomar los items.
            // Para el start_author/permlink de la API de Hive, ya Hive lo maneja.
            if (start_author && start_permlink && item.author === start_author && item.permlink === start_permlink) {
                 // Si este item es el duplicado exacto del start_permlink, lo ignoramos AHORA
                 // para que no se incluya en el conteo de `parsedLimit`.
                 return false;
            }

            if (contentType === 'posts') {
                return !item.reblogged_by || item.reblogged_by.length === 0;
            } else if (contentType === 'reblogs') {
                return item.reblogged_by && item.reblogged_by.length > 0;
            }
            return false; // Si contentType no es 'posts' ni 'reblogs', no incluimos nada.
        }).slice(0, parsedLimit); // Tomamos solo el límite solicitado después de filtrar

        // La respuesta a cachear es el feed completo de Hive, sin filtrar por contentType.
        // Esto permite que el cliente pida "posts" o "reblogs" del mismo caché.
        const responseToCache = {
            posts: allFetchedItems, // Cacheamos el feed completo
            nextStartAuthor: calculatedNextStartAuthor,
            nextStartPermlink: calculatedNextStartPermlink,
            hasMore: calculatedHasMore
        };

        if (allFetchedItems.length > 0) { 
            const cacheDuration = allFetchedItems.every(item => isOldPost(item.created)) ? 60 * 60 * 24 * 30 : 60 * 5;
            try {
                await Promise.race([redisClient.set(cacheKey, JSON.stringify(responseToCache), 'EX', cacheDuration), timeoutPromise]); 
                console.log(`Cache SET for key: ${cacheKey} (Feed completo, duración: ${cacheDuration / 60} min).`);
            } catch (redisErr) {
                console.error(`Error trying to save to Redis ${cacheKey}:`, redisErr);
            }
        }
        
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                posts: finalFilteredPostsForClient, // Al cliente solo le enviamos los filtrados y limitados
                nextStartAuthor: calculatedNextStartAuthor, // La paginación se basa en el feed completo
                nextStartPermlink: calculatedNextStartPermlink,
                hasMore: calculatedHasMore
            }),
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