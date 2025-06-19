// netlify/functions/get-user-posts.js
const Redis = require('ioredis'); // Importa el cliente Redis
const fetch = require('node-fetch'); // Asumiendo que ya usas node-fetch para la API de Hive

// Configura la conexión a Redis usando las variables de entorno de Netlify
// Asegúrate de que estas variables estén configuradas en Netlify
const redis = new Redis({
    port: 6380, // Puerto estándar para Redis sobre SSL/TLS
    host: process.env.UPSTASH_REDIS_URL.split('rediss://')[1], // Extrae el host de la URL
    password: process.env.UPSTASH_REDIS_PASSWORD,
    tls: {
        rejectUnauthorized: false // Puede ser necesario para algunos entornos serverless
    }
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

        // Construir la clave de caché. Una clave simple podría ser el usuario y el offset/limit.
        // Para posts individuales, la clave podría ser `hive:post:${author}:${permlink}`
        // Para listas de posts, una clave basada en los parámetros de la consulta es buena.
        const cacheKey = `hive:posts:${username}:${limit}:${start_author || 'null'}:${start_permlink || 'null'}`;
        
        // 1. Intentar obtener de la caché
        const cachedResponse = await redis.get(cacheKey);
        if (cachedResponse) {
            console.log(`Cache HIT para clave: ${cacheKey}`);
            // Verificar si el caché contiene solo posts viejos.
            // Si la respuesta cacheada es solo de posts > 7 días, es un hit válido.
            // Para simplicidad, si la clave existe, asumimos que es válida para este ejemplo.
            // En una implementación más avanzada, podrías guardar un timestamp en la caché.
            const parsedData = JSON.parse(cachedResponse);
            
            // Si todos los posts en este lote cacheado son viejos, podemos usarlo directamente.
            // Si hubiera mezcla de posts nuevos y viejos, la lógica se complica,
            // pero para un `limit` dado y `start_author/permlink`, un solo cache key es suficiente.
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
        // Cachear solo si todos los posts en esta respuesta son "viejos" (más de 7 días).
        // Si hay algún post "nuevo", no cacheamos este lote para asegurar frescura.
        const allPostsAreOld = posts.every(post => isOldPost(post.created));

        if (allPostsAreOld && posts.length > 0) {
            // Guardar en caché con una expiración muy larga (ej. 30 días, o -1 para nunca expirar)
            // Ya que son inmutables, podríamos no ponerle TTL (o un TTL muy largo)
            await redis.set(cacheKey, JSON.stringify({ posts }), 'EX', 60 * 60 * 24 * 30); // 30 días de caché
            console.log(`Cache SET para clave: ${cacheKey} (posts viejos).`);
        } else if (posts.length > 0) {
            // Si hay posts nuevos en el lote, cachear por un período muy corto (ej. 5 minutos)
            // para reducir hits rápidos, pero permitir que se actualice.
            await redis.set(cacheKey, JSON.stringify({ posts }), 'EX', 60 * 5); // 5 minutos de caché
            console.log(`Cache SET para clave: ${cacheKey} (posts recientes).`);
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