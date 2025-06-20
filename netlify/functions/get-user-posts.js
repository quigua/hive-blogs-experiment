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
        }, 9000); // Límite de tiempo para operaciones asíncronas
    });

    try {
        // Inicialización o re-establecimiento de la conexión a Redis
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

        // La clave del caché ahora incluye contentType para cachear posts y reblogs por separado.
        const cacheKey = `hive:${contentType}:${username}:${parsedLimit}:${start_author || 'null'}:${start_permlink || 'null'}`;

        let cachedResponse = null;
        try {
            // Intenta obtener de Redis, con timeout
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

        // Siempre pedimos 20, el máximo que Hive puede dar por llamada
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

        // Intenta obtener datos de Hive desde múltiples nodos
        for (const nodeUrl of hiveNodes) {
            console.log(`Attempting fetch with Hive node: ${nodeUrl}`);
            try {
                hiveResponse = await Promise.race([
                    fetch(nodeUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                    }),
                    timeoutPromise // Aplica timeout también a la llamada fetch
                ]);

                if (hiveResponse.ok) {
                    hiveError = null;
                    break; // Salimos del bucle si encontramos un nodo que funciona
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

        // --- FILTRADO POR TIPO (posts originales O reblogs) ---
        const filteredItems = [];
        let skippedInitialDuplicate = false; // Bandera para saltar el primer elemento si es un duplicado de start_permlink.

        for (const item of allFetchedItems) {
            // Si hay un start_author/permlink y este item es el duplicado inicial, lo saltamos.
            if (!skippedInitialDuplicate && start_author && start_permlink &&
                item.author === start_author && item.permlink === start_permlink) {
                skippedInitialDuplicate = true;
                continue; // Saltar este item duplicado
            }

            if (contentType === 'posts') {
                // Filtro para posts originales: autor debe ser el mismo y no debe ser reblog.
                if (item.author === username && (!item.reblogged_by || item.reblogged_by.length === 0)) {
                    filteredItems.push(item);
                }
            } else if (contentType === 'reblogs') {
                // Filtro para reblogs: debe tener reblogged_by (y ser array), debe contener al username,
                // Y ¡CRUCIAL! el autor de la publicación NO debe ser el username.
                if (item.reblogged_by && Array.isArray(item.reblogged_by) && item.reblogged_by.includes(username) && item.author !== username) {
                     filteredItems.push(item);
                }
            }
            // Si contentType no coincide, o no es 'posts' ni 'reblogs', el item no se añade.
        }

        // Tomamos solo la cantidad necesaria para el lote actual.
        const currentBatchItems = filteredItems.slice(0, parsedLimit);

        // --- DETERMINACIÓN DE LA PRÓXIMA PÁGINA (nextStartAuthor/Permlink) ---
        // La paginación SIEMPRE se basa en el ÚLTIMO elemento de la respuesta ORIGINAL de Hive.
        // Esto es CRUCIAL para que Hive siga avanzando en el feed del usuario y no se "atasque"
        // intentando encontrar más posts filtrados si no los hay en el lote actual.
        let nextStartAuthor = null;
        let nextStartPermlink = null;
        let hasMore = true; // Asumimos que hay más hasta que Hive nos diga lo contrario.

        if (allFetchedItems.length < requestLimitToHive || allFetchedItems.length === 0) {
            // Si Hive nos dio menos de 20 posts, o ningún post, no hay más en el feed general del blog.
            hasMore = false;
        } else {
            // Si Hive nos dio un lote completo de 20 posts, asumimos que hay más por pedir.
            // El nextStart siempre apunta al último post de la respuesta CRUDA de Hive.
            const lastItemFromHive = allFetchedItems[allFetchedItems.length - 1];
            nextStartAuthor = lastItemFromHive.author;
            nextStartPermlink = lastItemFromHive.permlink;
            hasMore = true;
        }

        const responseData = {
            posts: currentBatchItems, // Devolvemos solo los posts filtrados y limitados.
            nextStartAuthor: nextStartAuthor, // La paginación siempre es del feed completo de Hive.
            nextStartPermlink: nextStartPermlink,
            hasMore: hasMore
        };

        // Cachea la respuesta solo si hay posts y determina la duración del caché.
        if (currentBatchItems.length > 0) {
            const cacheDuration = currentBatchItems.every(item => isOldPost(item.created)) ? 60 * 60 * 24 * 30 : 60 * 5; // 30 días para posts viejos, 5 minutos para nuevos
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
        // No llamamos a redisClient.quit() aquí, permitiendo la reutilización de la conexión.
    }
};