// netlify/functions/get-user-posts.js
const Redis = require('ioredis');
const fetch = require('node-fetch');

const redisUrl = process.env.UPSTASH_REDIS_URL;
const redisPassword = process.env.UPSTASH_REDIS_PASSWORD;

// Declara la instancia de Redis fuera del handler para posible reutilización
// pero con un mecanismo de conexión/reconexión robusto.
let redis = null;

function getRedisClient() {
    if (!redis || redis.status === 'end' || redis.status === 'wait') { // Check if connection needs to be re-established
        console.log('[ioredis] Initializing or re-establishing Redis connection...');
        redis = new Redis(redisUrl, {
            password: redisPassword,
            tls: {}
        });

        redis.on('error', (err) => {
            console.error('[ioredis] Error de conexión o operación:', err.message, err.code, err.address);
            // Optionally, try to reconnect here or let ioredis handle it
        });
        redis.on('connect', () => {
            console.log('[ioredis] Conectado a Redis!');
        });
        redis.on('reconnecting', () => {
            console.warn('[ioredis] Reconectando a Redis...');
        });
        redis.on('end', () => {
            console.warn('[ioredis] Conexión a Redis terminada (fuera de control).');
            // Reset redis instance so it gets re-initialized on next invocation
            redis = null; 
        });
    }
    return redis;
}

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

    // Obtener la instancia de Redis al inicio de cada invocación
    const currentRedis = getRedisClient();

    try {
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
        const randomNode = hiveNodes[Math.floor(Math.random() * hiveNodes.length)];

        const cacheKey = `hive:${contentType}:${username}:${limit}:${start_author || 'null'}:${start_permlink || 'null'}`;
        
        let cachedResponse = null;
        try {
            // Usa la instancia actual de Redis
            cachedResponse = await Promise.race([currentRedis.get(cacheKey), timeoutPromise]);
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

        const hiveResponse = await Promise.race([
            fetch(randomNode, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }),
            timeoutPromise
        ]);

        if (!hiveResponse.ok) {
            const errorText = await hiveResponse.text();
            throw new Error(`Error de la API de Hive: ${hiveResponse.status} - ${errorText}`);
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
                await Promise.race([currentRedis.set(cacheKey, JSON.stringify({ posts: finalItems }), 'EX', 60 * 60 * 24 * 30), timeoutPromise]); 
                console.log(`Cache SET para clave: ${cacheKey} (${contentType} viejos, filtrados).`);
            } catch (redisErr) {
                console.error(`Error al intentar guardar en Redis (${contentType} viejos) ${cacheKey}:`, redisErr);
            }
        } else if (finalItems.length > 0) { 
            try {
                await Promise.race([currentRedis.set(cacheKey, JSON.stringify({ posts: finalItems }), 'EX', 60 * 5), timeoutPromise]); 
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
        // En este patrón, no llamamos a redis.quit() aquí.
        // Permitimos que la conexión sea gestionada por el entorno de la función para posibles reutilizaciones.
        // Netlify/Lambda limpiarán la conexión cuando la instancia de la función se "congele".
    }
};