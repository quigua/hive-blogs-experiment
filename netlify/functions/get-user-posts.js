// netlify/functions/get-user-posts.js
const Redis = require('ioredis');
const fetch = require('node-fetch');

// Asegúrate de que UPSTASH_REDIS_URL es una URL completa con el formato rediss://:password@host:port
const redisUrl = process.env.UPSTASH_REDIS_URL;
const redisPassword = process.env.UPSTASH_REDIS_PASSWORD;

if (!redisUrl) {
    console.error("ERROR: UPSTASH_REDIS_URL no está configurada.");
}
if (!redisPassword) {
    console.error("ERROR: UPSTASH_REDIS_PASSWORD no está configurada.");
}

const redis = new Redis(redisUrl, {
    password: redisPassword,
    tls: {}
});

redis.on('error', (err) => {
    console.error('[ioredis] Error de conexión o operación:', err.message, err.code, err.address);
});
redis.on('connect', () => {
    console.log('[ioredis] Conectado a Redis!');
});
redis.on('reconnecting', () => {
    console.warn('[ioredis] Reconectando a Redis...');
});
redis.on('end', () => {
    console.warn('[ioredis] Conexión a Redis terminada.');
});

function isOldPost(createdDate) {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    return new Date(createdDate) < sevenDaysAgo;
}

exports.handler = async (event, context) => {
    const timeoutPromise = new Promise((resolve, reject) => {
        setTimeout(() => {
            reject(new Error('Function execution timed out before completing.'));
        }, 9000); // 9 segundos, un poco menos que el timeout de Netlify
    });

    try {
        // --- CAMBIO CLAVE AQUÍ: Añadimos 'contentType' ---
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

        // --- CAMBIO CLAVE AQUÍ: La clave de caché ahora incluye el tipo de contenido ---
        const cacheKey = `hive:${contentType}:${username}:${limit}:${start_author || 'null'}:${start_permlink || 'null'}`;
        
        let cachedResponse = null;
        try {
            cachedResponse = await Promise.race([redis.get(cacheKey), timeoutPromise]);
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

        const body = {
            jsonrpc: '2.0',
            id: 1,
            method: 'condenser_api.get_discussions_by_blog',
            params: [{
                tag: username,
                limit: parseInt(limit), // El límite ahora es el total que pide Hive
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

        const allFetchedItems = hiveData.result || []; // Ahora obtenemos todos los items posibles

        let finalItems = [];
        if (contentType === 'posts') {
            finalItems = allFetchedItems.filter(item => !item.reblogged_by || item.reblogged_by.length === 0);
        } else if (contentType === 'reblogs') {
            finalItems = allFetchedItems.filter(item => item.reblogged_by && item.reblogged_by.length > 0);
        } else {
            // Si el contentType es desconocido, devolvemos todo (o un error)
            finalItems = allFetchedItems; 
        }

        // Importante: No aplicamos el límite aquí, ya que Hive ya lo hizo.
        // La paginación en el cliente manejará qué mostrar.
        
        const allItemsAreOld = finalItems.every(item => isOldPost(item.created));

        if (allItemsAreOld && finalItems.length > 0) { 
            try {
                await Promise.race([redis.set(cacheKey, JSON.stringify({ posts: finalItems }), 'EX', 60 * 60 * 24 * 30), timeoutPromise]); 
                console.log(`Cache SET para clave: ${cacheKey} (${contentType} viejos, filtrados).`);
            } catch (redisErr) {
                console.error(`Error al intentar guardar en Redis (${contentType} viejos) ${cacheKey}:`, redisErr);
            }
        } else if (finalItems.length > 0) { 
            try {
                await Promise.race([redis.set(cacheKey, JSON.stringify({ posts: finalItems }), 'EX', 60 * 5), timeoutPromise]); 
                console.log(`Cache SET para clave: ${cacheKey} (${contentType} recientes, filtrados).`);
            } catch (redisErr) {
                console.error(`Error al intentar guardar en Redis (${contentType} recientes) ${cacheKey}:`, redisErr);
            }
        }
        
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ posts: finalItems }), // Devuelve los ítems filtrados
        };

    } catch (error) {
        console.error('Error en la función get-user-posts (capturado):', error.message, error.stack);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Error interno del servidor', details: error.message }),
        };
    } finally {
        if (redis && redis.status === 'ready') {
            redis.quit();
            console.log('[ioredis] Conexión Redis cerrada.');
        }
    }
};