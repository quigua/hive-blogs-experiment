// netlify/functions/get-user-posts.js
const Redis = require('ioredis');
const fetch = require('node-fetch');

// La instancia de Redis se declarará aquí pero se inicializará
// de forma segura dentro del handler o una función async.
let redisClient = null; // Renombrado para mayor claridad

// Función auxiliar para comprobar si un post es "viejo" (inmutable)
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
        }, 9000); // 9 segundos, un poco menos que el timeout de Netlify
    });

    try {
        // --- Lógica de inicialización/reutilización de Redis dentro del handler ---
        if (!redisClient || redisClient.status === 'end' || redisClient.status === 'wait') {
            console.log('[ioredis] Initializing or re-establishing Redis connection...');
            const redisUrl = process.env.UPSTASH_REDIS_URL;
            const redisPassword = process.env.UPSTASH_REDIS_PASSWORD;

            if (!redisUrl) {
                console.error("ERROR: UPSTASH_REDIS_URL no está configurada.");
                // Retornar un error temprano si las variables críticas no están
                return {
                    statusCode: 500,
                    body: JSON.stringify({ error: 'Falta la configuración de Redis URL.' }),
                };
            }
            if (!redisPassword) {
                console.error("ERROR: UPSTASH_REDIS_PASSWORD no está configurada.");
                return {
                    statusCode: 500,
                    body: JSON.stringify({ error: 'Falta la configuración de Redis Password.' }),
                };
            }

            redisClient = new Redis(redisUrl, {
                password: redisPassword,
                tls: {}
            });

            redisClient.on('error', (err) => {
                console.error('[ioredis] Error de conexión o operación:', err.message, err.code, err.address);
            });
            redisClient.on('connect', () => {
                console.log('[ioredis] Conectado a Redis!');
            });
            redisClient.on('reconnecting', () => {
                console.warn('[ioredis] Reconectando a Redis...');
            });
            redisClient.on('end', () => {
                console.warn('[ioredis] Conexión a Redis terminada (fuera de control). Reseteando cliente.');
                redisClient = null; // Para que se inicialice de nuevo en la próxima invocación
            });
        }
        // --- Fin de la lógica de Redis ---


        const { username, limit, start_author, start_permlink, contentType = 'posts' } = event.queryStringParameters;

        if (!username || !limit) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Faltan parámetros: username o limit.' }),
            };
        }

        const hiveNodes = [
            'https://api.hive.blog',
            'https://api.deathwing.me',
            'https://api.pharesim.me'
        ];
        
        const cacheKey = `hive:${contentType}:${username}:${limit}:${start_author || 'null'}:${start_permlink || 'null'}`;
        
        let cachedResponse = null;
        try {
            // Usa la instancia `redisClient` inicializada/reutilizada
            cachedResponse = await Promise.race([redisClient.get(cacheKey), timeoutPromise]);
        } catch (redisErr) {
            console.error(`Error al intentar obtener de Redis para ${cacheKey}:`, redisErr);
            // Continúa sin caché si hay un error en Redis
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

        const body = {
            jsonrpc: '2.0',
            id: 1,
            method: 'condenser_api.get_discussions_by_blog',
            params: [{
                tag: username,
                limit: parseInt(limit), 
                start_author: start_author || undefined,
                start_permlink: start_permlink || undefined,
            }],
        };

        let hiveResponse;
        let hiveError = null;

        for (const nodeUrl of hiveNodes) {
            console.log(`Intentando fetch con nodo Hive: ${nodeUrl}`);
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
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Error de la API de Hive', details: hiveData.error }),
            };
        }

        const allFetchedItems = hiveData.result || [];

        let finalItems = [];
        if (contentType === 'posts') {
            finalItems = allFetchedItems.filter(item => !item.reblogged_by || item.reblogged_by.length === 0);
        } else if (contentType === 'reblogs') {
            finalItems = allFetchedItems.filter(item => item.reblogged_by && item.reblogged_by.length > 0);
        } else {
            finalItems = allFetchedItems; 
        }
        
        const allItemsAreOld = finalItems.every(item => isOldPost(item.created));

        if (allItemsAreOld && finalItems.length > 0) { 
            try {
                // Usa la instancia `redisClient`
                await Promise.race([redisClient.set(cacheKey, JSON.stringify({ posts: finalItems }), 'EX', 60 * 60 * 24 * 30), timeoutPromise]); 
                console.log(`Cache SET para clave: ${cacheKey} (${contentType} viejos, filtrados).`);
            } catch (redisErr) {
                console.error(`Error al intentar guardar en Redis (${contentType} viejos) ${cacheKey}:`, redisErr);
            }
        } else if (finalItems.length > 0) { 
            try {
                // Usa la instancia `redisClient`
                await Promise.race([redisClient.set(cacheKey, JSON.stringify({ posts: finalItems }), 'EX', 60 * 5), timeoutPromise]); 
                console.log(`Cache SET para clave: ${cacheKey} (${contentType} recientes, filtrados).`);
            } catch (redisErr) {
                console.error(`Error al intentar guardar en Redis (${contentType} recientes) ${cacheKey}:`, redisErr);
            }
        }
        
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ posts: finalItems }),
        };

    } catch (error) {
        console.error('Error en la función get-user-posts (capturado):', error.message, error.stack);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Error interno del servidor', details: error.message }),
        };
    } finally {
        // No llamamos a redisClient.quit() aquí.
        // Permitimos que la instancia de la función sea reutilizada en warm starts.
    }
};