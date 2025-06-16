// netlify/functions/get-user-posts.js
const hive = require('@hiveio/hive-js');

exports.handler = async (event, context) => {
    hive.config.set('websocket', 'https://api.hive.blog'); 

    const username = event.queryStringParameters.username || 'quigua';
    const limit = parseInt(event.queryStringParameters.limit) || 20; // Nuevo parámetro para el límite, por defecto 20
    let lastPermlink = event.queryStringParameters.start_permlink || null;
    let lastAuthor = event.queryStringParameters.start_author || null;

    const allUserPosts = [];
    const reblogs = [];
    let fetchedCount = 0;
    const fetchBatchSize = 100; // Número de publicaciones a buscar en cada llamada a la API
    let hasMore = true;

    try {
        while (hasMore && fetchedCount < limit) {
            const query = {
                tag: username,
                limit: fetchBatchSize,
            };

            if (lastAuthor && lastPermlink) {
                query.start_author = lastAuthor;
                query.start_permlink = lastPermlink;
            }

            const postsBatch = await hive.api.getDiscussionsByBlogAsync(query);

            // Si la primera publicación del batch es la misma que la última de la iteración anterior,
            // significa que estamos pidiendo el mismo elemento de inicio, así que lo saltamos.
            if (lastPermlink && postsBatch.length > 0 && postsBatch[0].author === lastAuthor && postsBatch[0].permlink === lastPermlink) {
                postsBatch.shift(); // Elimina el elemento duplicado
            }

            if (postsBatch.length === 0) {
                hasMore = false;
                break;
            }

            for (const post of postsBatch) {
                if (post.author === username) {
                    allUserPosts.push({
                        id: post.id,
                        author: post.author,
                        permlink: post.permlink,
                        title: post.title,
                        summary: post.body.substring(0, 200) + '...', // Resumen
                        created: post.created,
                        url: `https://hive.blog/@<span class="math-inline">\{post\.author\}/</span>{post.permlink}`,
                        body: post.body // Incluimos el cuerpo completo para la página de detalle
                    });
                    fetchedCount++;
                } else {
                    reblogs.push({
                        id: post.id,
                        author: post.author,
                        permlink: post.permlink,
                        title: post.title,
                        created: post.created,
                        url: `https://hive.blog/@<span class="math-inline">\{post\.author\}/</span>{post.permlink}`,
                        original_author: username // El usuario que hizo el reblog
                    });
                }

                if (fetchedCount >= limit) {
                    break; // Hemos alcanzado el límite deseado
                }
            }

            if (postsBatch.length < fetchBatchSize) {
                hasMore = false; // No hay más posts si el batch es más pequeño que el tamaño solicitado
            } else {
                // Prepara para la siguiente iteración
                const lastPostInBatch = postsBatch[postsBatch.length - 1];
                lastAuthor = lastPostInBatch.author;
                lastPermlink = lastPostInBatch.permlink;
            }
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                username: username,
                posts: allUserPosts,
                reblogs: reblogs,
                hasMore: hasMore, // Indica si hay más posts disponibles más allá del límite solicitado
                next_start_author: allUserPosts.length > 0 ? allUserPosts[allUserPosts.length - 1].author : null,
                next_start_permlink: allUserPosts.length > 0 ? allUserPosts[allUserPosts.length - 1].permlink : null,
            }),
        };
    } catch (error) {
        console.error("Error al obtener publicaciones de Hive:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Error al comunicarse con la blockchain de Hive para obtener publicaciones.", details: error.message }),
        };
    }
};