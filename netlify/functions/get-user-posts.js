// netlify/functions/get-user-posts.js
const Redis = require('ioredis');
const fetch = require('node-fetch');

// Configura la conexión a Redis usando la URL completa de las variables de entorno de Netlify
// ¡Asegúrate de que UPSTASH_REDIS_URL sea la URL completa (ej. rediss://[host]:[port])!
const redis = new Redis(process.env.UPSTASH_REDIS_URL, {
    password: process.env.UPSTASH_REDIS_PASSWORD, // Algunas URLs de Upstash ya incluyen la contraseña
                                                  // pero especificarla explícitamente es más seguro si tu URL no lo hace.
    tls: {
        rejectUnauthorized: false // Esto a veces es necesario en Netlify por temas de certificados
    }
});

// **Importante:** Añade un manejador de errores para ioredis, así no se bloquea la función en despliegue
// Esto te ayudará a ver errores de conexión sin que Netlify cierre la función.
redis.on('error', (err) => {
    console.error('[ioredis] Error de conexión o operación:', err);
});
redis.on('connect', () => {
    console.log('[ioredis] Conectado a Redis!');
});


// Función auxiliar para calcular si un post es "viejo" (inmutable)
function isOldPost(createdDate) {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    return new Date(createdDate) < sevenDaysAgo;
}

exports.handler = async (event, context) => {
    try {
        const { username, limit, start_author, start_permlink } = event.queryStringParameters;

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

        const cacheKey = `hive:posts:${username}:${limit}:${start_author || 'null'}:${start_permlink || 'null'}`;
        
        // 1. Intentar obtener de la caché
        let cachedResponse = null;
        try {
            cachedResponse = await redis.get(cacheKey);
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

        // 2. Si no está en caché, ir a la API de Hive
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

        const hiveResponse = await fetch(randomNode, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

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

        const posts = hiveData.result || [];

        // Lógica de caché:
        const allPostsAreOld = posts.every(post => isOldPost(post.created));

        if (allPostsAreOld && posts.length > 0) {
            try {
                await redis.set(cacheKey, JSON.stringify({ posts }), 'EX', 60 * 60 * 24 * 30); // 30 días de caché
                console.log(`Cache SET para clave: ${cacheKey} (posts viejos).`);
            } catch (redisErr) {
                console.error(`Error al intentar guardar en Redis (posts viejos) ${cacheKey}:`, redisErr);
            }
        } else if (posts.length > 0) {
            try {
                await redis.set(cacheKey, JSON.stringify({ posts }), 'EX', 60 * 5); // 5 minutos de caché
                console.log(`Cache SET para clave: ${cacheKey} (posts recientes).`);
            } catch (redisErr) {
                console.error(`Error al intentar guardar en Redis (posts recientes) ${cacheKey}:`, redisErr);
            }
        }
        
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ posts }),
        };

    } catch (error) {
        console.error('Error en la función get-user-posts:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Error interno del servidor', details: error.message }),
        };
    }
};