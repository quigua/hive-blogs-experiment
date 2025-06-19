// netlify/functions/get-user-posts.js
const Redis = require('ioredis');
const fetch = require('node-fetch');

// Declare redisClient globally but do NOT initialize it here with 'new Redis()'
// The initialization happens inside the async handler.
let redisClient = null; 

function isOldPost(createdDate) {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    return new Date(createdDate) < sevenDaysAgo;
}

exports.handler = async (event, context) => {
    // Definimos el timeout por cada invocación para asegurarnos que se aplica
    const timeoutPromise = new Promise((resolve, reject) => {
        setTimeout(() => {
            reject(new Error('Function execution timed out before completing.'));
        }, 9000); 
    });

    try {
        // --- Lógica de inicialización/reutilización de Redis dentro del handler ---
        // Toda la lógica que involucra 'new Redis()' y 'redisClient.status' debe estar aquí.
        if (!redisClient || redisClient.status === 'end' || redisClient.status === 'wait') {
            console.log('[ioredis] Initializing or re-establishing Redis connection...');
            const redisUrl = process.env.UPSTASH_REDIS_URL;
            const redisPassword = process.env.UPSTASH_REDIS_PASSWORD;

            if (!redisUrl) {
                console.error("ERROR: UPSTASH_REDIS_URL no está configurada.");
                return { statusCode: 500, body: JSON.stringify({ error: 'Falta la configuración de Redis URL.' }) };
            }
            if (!redisPassword) {
                console.error("ERROR: UPSTASH_REDIS_PASSWORD no está configurada.");
                return { statusCode: 500, body: JSON.stringify({ error: 'Falta la configuración de Redis Password.' }) };
            }

            redisClient = new Redis(redisUrl, { password: redisPassword, tls: {} });
            
            // Adjuntar los listeners solo una vez por instancia si es nueva
            // Aseguramos que solo se añaden los listeners la primera vez que se crea el cliente
            // para evitar añadir duplicados en reusos de la misma instancia 'warm'.
            // Esta es una forma simple, en producción, podrías querer un patrón de singleton más robusto.
            if (!redisClient.__listenersAttached) {
                redisClient.on('error', (err) => console.error('[ioredis] Error de conexión o operación:', err.message, err.code, err.address));
                redisClient.on('connect', () => console.log('[ioredis] Conectado a Redis!'));
                redisClient.on('reconnecting', () => console.warn('[ioredis] Reconectando a Redis...'));
                redisClient.on('end', () => { console.warn('[ioredis] Conexión a Redis terminada. Reseteando cliente.'); redisClient = null; });
                redisClient.__listenersAttached = true; // Marca que los listeners ya fueron adjuntados
            }
        }
        // --- Fin de la lógica de Redis ---

        const { username, limit, start_author, start_permlink, contentType = 'posts' } = event.queryStringParameters;
        const parsedLimit = parseInt(limit);

        if (!username || !parsedLimit) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Faltan parámetros: username o limit.' }) };
        }

        const hiveNodes = [
            'https://api.hive.blog',
            'https://api.deathwing.me',
            'https://api.pharesim.me'
        ];
        
        const cacheKey = `hive:${contentType}:${username}:${parsedLimit}:${start_author || 'null'}:${start_permlink || 'null'}`;
        
        let cachedResponse = null;
        try {
            // Este await está dentro de la función async handler, por lo que es válido.
            cachedResponse = await Promise.race([redisClient.get(cacheKey), timeoutPromise]);
        } catch (redisErr) {
            console.error(`Error al intentar obtener de Redis para ${cacheKey}:`, redisErr);
        }
       
        if (cachedResponse) {
            console.log(`Cache HIT para clave: ${cacheKey}`);
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: cachedResponse,
            };
        }
        console.log(`Cache MISS para clave: ${cacheKey}. Fetching from Hive.`);

        const requestLimitToHive = (parsedLimit * 2) + 1; 

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
            console.log(`Intentando fetch con nodo Hive: ${nodeUrl}`);
            try {
                // Este await está dentro de la función async handler, por lo que es válido.
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
                    hiveError = new Error(`Error de la API de Hive en ${nodeUrl}: ${hiveResponse.status} - ${errorText}`);
                    console.error(hiveError.message);
                }
            } catch (error) {
                hiveError = new Error(`Error de red al conectar con ${nodeUrl}: ${error.message}`);
                console.error(hiveError.message);
            }
        }

        if (!hiveResponse || !hiveResponse.ok) {
            throw hiveError || new Error('No se pudo conectar a ningún nodo de Hive.');
        }

        const hiveData = await hiveResponse.json();

        if (hiveData.error) {
            console.error('Error de Hive:', hiveData.error);
            return { statusCode: 500, body: JSON.stringify({ error: 'Error de la API de Hive', details: hiveData.error }) };
        }

        const allFetchedItems = hiveData.result || [];

        const typeFilteredItems = allFetchedItems.filter(item => {
            if (contentType === 'posts') {
                return !item.reblogged_by || item.reblogged_by.length === 0;
            } else if (contentType === 'reblogs') {
                return item.reblogged_by && item.reblogged_by.length > 0;
            }
            return true;
        });

        let cleanedItems = typeFilteredItems;
        if (start_author && start_permlink && typeFilteredItems.length > 0 &&
            typeFilteredItems[0].author === start_author &&
            typeFilteredItems[0].permlink === start_permlink) {
            cleanedItems = typeFilteredItems.slice(1);
        }

        const currentBatchItems = cleanedItems.slice(0, parsedLimit);

        let nextStartAuthor = null;
        let nextStartPermlink = null;
        let hasMore = true;

        if (currentBatchItems.length < parsedLimit) {
            hasMore = false;
        } else {
            const lastItemInCurrentBatch = currentBatchItems[currentBatchItems.length - 1];
            
            const lastItemIndexInOriginal = allFetchedItems.findIndex(item => 
                item.author === lastItemInCurrentBatch.author && 
                item.permlink === lastItemInCurrentBatch.permlink
            );

            if (lastItemIndexInOriginal !== -1 && (lastItemIndexInOriginal + 1) < allFetchedItems.length) {
                const nextItem = allFetchedItems[lastItemIndexInOriginal + 1];
                nextStartAuthor = nextItem.author;
                nextStartPermlink = nextItem.permlink;
            } else {
                hasMore = false;
            }
        }

        const responseData = {
            posts: currentBatchItems,
            nextStartAuthor: nextStartAuthor,
            nextStartPermlink: nextStartPermlink,
            hasMore: hasMore
        };
        
        if (currentBatchItems.length > 0) { 
            const cacheDuration = allFetchedItems.every(item => isOldPost(item.created)) ? 60 * 60 * 24 * 30 : 60 * 5;
            try {
                // Este await está dentro de la función async handler, por lo que es válido.
                await Promise.race([redisClient.set(cacheKey, JSON.stringify(responseData), 'EX', cacheDuration), timeoutPromise]); 
                console.log(`Cache SET para clave: ${cacheKey} (${contentType} filtrados, duración: ${cacheDuration / 60} min).`);
            } catch (redisErr) {
                console.error(`Error al intentar guardar en Redis ${cacheKey}:`, redisErr);
            }
        }
        
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(responseData),
        };

    } catch (error) {
        console.error('Error en la función get-user-posts (capturado):', error.message, error.stack);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Error interno del servidor', details: error.message }),
        };
    } finally {
        // No llamamos a redisClient.quit() aquí.
    }
};