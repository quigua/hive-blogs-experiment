// netlify/functions/get-user-posts.js
const hive = require('@hiveio/hive-js');

exports.handler = async (event, context) => {
    hive.config.set('websocket', 'https://api.hive.blog');

    const username = event.queryStringParameters.username || 'quigua';
    const limit = parseInt(event.queryStringParameters.limit) || 20;
    let startAuthor = event.queryStringParameters.start_author || null;
    let startPermlink = event.queryStringParameters.start_permlink || null;

    const allUserPosts = [];
    const reblogs = [];
    let fetchedOriginalPostsCount = 0;
    const fetchBatchSize = 100;
    let hasMore = true;
    let totalItemsFetched = 0; // Para controlar el total de ítems de la API

    try {
        while (hasMore && fetchedOriginalPostsCount < limit) {
            const query = {
                tag: username,
                limit: fetchBatchSize,
            };

            // Si estamos paginando, ajusta los parámetros de inicio
            if (startAuthor && startPermlink) {
                query.start_author = startAuthor;
                query.start_permlink = startPermlink;
            }

            const postsBatch = await hive.api.getDiscussionsByBlogAsync(query);

            // Si es la primera llamada y se especifica start_permlink/start_author,
            // la API incluye el elemento de inicio en el resultado. Lo eliminamos.
            // También si subsiguientes llamadas traen el mismo primer post.
            if (postsBatch.length > 0 && startAuthor && startPermlink && postsBatch[0].author === startAuthor && postsBatch[0].permlink === startPermlink) {
                postsBatch.shift();
            }

            if (postsBatch.length === 0) {
                hasMore = false; // No hay más publicaciones
                break;
            }

            for (const post of postsBatch) {
                totalItemsFetched++; // Contar todos los items que trae la API

                // Verificar si es una publicación original del usuario o un reblog
                // Un reblog en getDiscussionsByBlogAsync tiene post.author diferente a 'username'
                // pero aparece en el feed de blog de 'username'.
                if (post.author === username) {
                    // Es una publicación original del usuario
                    allUserPosts.push({
                        id: post.id,
                        author: post.author,
                        permlink: post.permlink,
                        title: post.title,
                        summary: post.body ? post.body.substring(0, 200) + (post.body.length > 200 ? '...' : '') : '',
                        created: post.created,
                        url: `https://hive.blog/@<span class="math-inline">\{post\.author\}/</span>{post.permlink}`, // URL correcta
                        body: post.body // Incluir el cuerpo completo
                    });
                    fetchedOriginalPostsCount++;
                } else {
                    // Es un reblog
                    reblogs.push({
                        id: post.id,
                        author: post.author,
                        permlink: post.permlink,
                        title: post.title,
                        summary: post.body ? post.body.substring(0, 200) + (post.body.length > 200 ? '...' : '') : '',
                        created: post.created,
                        url: `https://hive.blog/@<span class="math-inline">\{post\.author\}/</span>{post.permlink}`, // URL correcta
                        reblogged_by: username // Quien hizo el reblog
                    });
                }

                if (fetchedOriginalPostsCount >= limit) {
                    break; // Hemos alcanzado el límite de publicaciones originales
                }
            }

            // Actualizar los parámetros de inicio para la próxima iteración
            // Asegurarse de que no estamos en un bucle infinito si el último batch está vacío o es el mismo
            if (postsBatch.length > 0) {
                const lastPostInBatch = postsBatch[postsBatch.length - 1];
                startAuthor = lastPostInBatch.author;
                startPermlink = lastPostInBatch.permlink;
            } else {
                hasMore = false; // Si el batch está vacío, no hay más posts
            }

            // Si el número de items fetched es menor que el tamaño del batch, no hay más para traer.
            if (postsBatch.length < fetchBatchSize) {
                hasMore = false;
            }
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                username: username,
                posts: allUserPosts, // Solo publicaciones originales del usuario
                reblogs: reblogs,   // Todos los reblogs encontrados
                hasMore: hasMore,   // Indica si podría haber más publicaciones originales disponibles
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