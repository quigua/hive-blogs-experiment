// netlify/functions/get-user-posts.js
const Redis = require('ioredis');
const fetch = require('node-fetch');

// Asegúrate de que UPSTASH_REDIS_URL es una URL completa con el formato rediss://:password@host:port
// Por ejemplo: rediss://:YOUR_PASSWORD@us1-vast-yak-33760.upstash.io:6379

const redisUrl = process.env.UPSTASH_REDIS_URL;
const redisPassword = process.env.UPSTASH_REDIS_PASSWORD;

// Verificación de variables de entorno para depuración
if (!redisUrl) {
    console.error("ERROR: UPSTASH_REDIS_URL no está configurada.");
    // No lanzar error aquí para permitir la depuración posterior, pero fallará la conexión.
}
if (!redisPassword) {
    console.error("ERROR: UPSTASH_REDIS_PASSWORD no está configurada.");
}

// Conexión a Redis usando la URL completa
// Es crucial que la URL sea del formato correcto para ioredis, incluyendo el esquema 'rediss://'
// y opcionalmente la contraseña incrustada, aunque la estamos pasando por separado también.
const redis = new Redis(redisUrl, {
    password: redisPassword, // Pasar la contraseña explícitamente es una buena práctica
    tls: {
        // rejectUnauthorized: false // Puede que no sea necesario con Upstash si sus certificados son válidos
                                  // Pero lo dejamos si da problemas de certificado
    }
});

// Manejadores de eventos para depuración de la conexión Redis
redis.on('error', (err) => {
    console.error('[ioredis] Error de conexión o operación:', err.message, err.code, err.address);
    // Para evitar que el error de ioredis se "trague" la ejecución, lanzamos un error que la función principal pueda capturar
    // No queremos que una conexión fallida a Redis detenga toda la función si Hive está disponible.
    // Pero en el caso de 'ECONNREFUSED' o 'ETIMEDOUT' en la conexión inicial, sí es crítico.
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


// Función auxiliar para calcular si un post es "viejo" (inmutable)
function isOldPost(createdDate) {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    return new Date(createdDate) < sevenDaysAgo;
}

exports.handler = async (event, context) => {
    // Añade un timeout para la función si se excede un tiempo razonable
    // para evitar el timeout de 10 segundos de Netlify en casos de larga espera por Redis/Hive.
    // Esto es más para manejar errores que para evitarlos.
    const timeoutPromise = new Promise((resolve, reject) => {
        setTimeout(() => {
            reject(new Error('Function execution timed out before completing.'));
        }, 9000); // 9 segundos, un poco menos que el timeout de Netlify
    });

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
        
        let cachedResponse = null;
        try {
            // Se usa Promise.race para manejar posibles bloqueos en la llamada a Redis
            cachedResponse = await Promise.race([redis.get(cacheKey), timeoutPromise]);
        } catch (redisErr) {
            console.error(`Error al intentar obtener de Redis para ${cacheKey}:`, redisErr);
            // Si Redis falla, continuamos sin caché
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

        // Se usa Promise.race para manejar posibles bloqueos en la llamada a Hive
        const hiveResponse = await Promise.race([
            fetch(randomNode, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }),
            timeoutPromise // Añadimos el timeout también para la llamada a Hive
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

        const posts = hiveData.result || [];

        const allPostsAreOld = posts.every(post => isOldPost(post.created));

        if (allPostsAreOld && posts.length > 0) {
            try {
                // Se usa Promise.race para manejar posibles bloqueos al guardar en Redis
                await Promise.race([redis.set(cacheKey, JSON.stringify({ posts }), 'EX', 60 * 60 * 24 * 30), timeoutPromise]);
                console.log(`Cache SET para clave: ${cacheKey} (posts viejos).`);
            } catch (redisErr) {
                console.error(`Error al intentar guardar en Redis (posts viejos) ${cacheKey}:`, redisErr);
            }
        } else if (posts.length > 0) {
            try {
                // Se usa Promise.race para manejar posibles bloqueos al guardar en Redis
                await Promise.race([redis.set(cacheKey, JSON.stringify({ posts }), 'EX', 60 * 5), timeoutPromise]);
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
        console.error('Error en la función get-user-posts (capturado):', error.message, error.stack);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Error interno del servidor', details: error.message }),
        };
    } finally {
        // Esto es crucial en entornos sin servidor: cierra la conexión Redis después de cada invocación
        // para liberar recursos. Si no haces esto, las conexiones pueden acumularse y causar problemas.
        if (redis && redis.status === 'ready') {
            redis.quit();
            console.log('[ioredis] Conexión Redis cerrada.');
        }
    }
};