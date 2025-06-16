// netlify/functions/get-user-posts.js
const hive = require('@hiveio/hive-js');

exports.handler = async (event, context) => {
    hive.config.set('websocket', 'https://api.hive.blog');

    const username = event.queryStringParameters.username || 'quigua';
    const limit = parseInt(event.queryStringParameters.limit) || 20; 
    let startPermlink = event.queryStringParameters.start_permlink || null;

    const posts = [];
    let hasMore = true;
    let count = 0;
    const fetchBatchSize = 100; 

    try {
        while (hasMore && count < limit) {
            const discussions = await hive.api.getDiscussionsByAuthorBeforeDateAsync(
                username,
                lastPermlink, // Este debería ser 'startPermlink' para la primera llamada y luego 'lastPermlink'
                '', 
                fetchBatchSize
            );

            // IMPORTANTE: getDiscussionsByAuthorBeforeDateAsync incluye el item de inicio en el resultado si no es null
            // Si lastPermlink tiene un valor y el primer item del batch coincide, lo eliminamos.
            let postsToAdd = discussions;
            if (lastPermlink && discussions.length > 0 && discussions[0].permlink === lastPermlink) {
                postsToAdd = discussions.slice(1);
            }

            if (postsToAdd.length === 0) {
                hasMore = false;
                break;
            }

            for (const post of postsToAdd) {
                if (count < limit) {
                    // Asegurarse de que las propiedades existen antes de intentar acceder a ellas
                    const title = post.title || 'Sin título';
                    const body = post.body || '';
                    const permlink = post.permlink || '';
                    const author = post.author || username; // Debería ser siempre 'username' aquí

                    posts.push({
                        id: post.id,
                        author: author,
                        permlink: permlink,
                        title: title,
                        summary: body.substring(0, 200) + (body.length > 200 ? '...' : ''),
                        created: post.created,
                        // Asegurarse de que se usan backticks (`) para la interpolación
                        url: `https://hive.blog/@${author}/${permlink}`, 
                        body: body 
                    });
                    count++;
                } else {
                    break;
                }
            }

            // Actualizar lastPermlink para la próxima paginación
            if (postsToAdd.length > 0) {
                lastPermlink = postsToAdd[postsToAdd.length - 1].permlink;
            } else {
                hasMore = false; // No hay más posts en este batch
            }

            if (postsToAdd.length < fetchBatchSize) {
                hasMore = false; // Si el batch es menor, no hay más para traer
            }
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                username: username,
                posts: posts, 
                reblogs: [], // Como getDiscussionsByAuthorBeforeDateAsync no devuelve reblogs
                hasMore: hasMore,
                next_start_permlink: posts.length > 0 ? posts[posts.length - 1].permlink : null,
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