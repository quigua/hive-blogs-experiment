// netlify/functions/get-user-posts.js
const hive = require('@hiveio/hive-js');

exports.handler = async (event, context) => {
    hive.config.set('websocket', 'https://api.hive.blog');

    const username = event.queryStringParameters.username || 'quigua';
    const limit = parseInt(event.queryStringParameters.limit) || 20; 
    let startPermlink = event.queryStringParameters.start_permlink || null; // Se mantiene la variable

    const posts = [];
    let hasMore = true;
    let count = 0;
    const fetchBatchSize = 100; 

    try {
        while (hasMore && count < limit) {
            const discussions = await hive.api.getDiscussionsByAuthorBeforeDateAsync(
                username,
                startPermlink, // <-- ¡CORRECCIÓN AQUÍ! Usamos startPermlink
                '', 
                fetchBatchSize
            );

            let postsToAdd = discussions;
            // Si startPermlink tiene un valor y el primer item del batch coincide, lo eliminamos.
            if (startPermlink && discussions.length > 0 && discussions[0].permlink === startPermlink) {
                postsToAdd = discussions.slice(1);
            }

            if (postsToAdd.length === 0) {
                hasMore = false;
                break;
            }

            for (const post of postsToAdd) {
                if (count < limit) {
                    const title = post.title || 'Sin título';
                    const body = post.body || '';
                    const permlink = post.permlink || '';
                    const author = post.author || username; 

                    posts.push({
                        id: post.id,
                        author: author,
                        permlink: permlink,
                        title: title,
                        summary: body.substring(0, 200) + (body.length > 200 ? '...' : ''),
                        created: post.created,
                        url: `https://hive.blog/@<span class="math-inline">\{author\}/</span>{permlink}`, 
                        body: body 
                    });
                    count++;
                } else {
                    break;
                }
            }

            // Actualizar startPermlink para la próxima paginación
            if (postsToAdd.length > 0) {
                startPermlink = postsToAdd[postsToAdd.length - 1].permlink;
            } else {
                hasMore = false; 
            }

            if (postsToAdd.length < fetchBatchSize) {
                hasMore = false;
            }
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                username: username,
                posts: posts, 
                reblogs: [], 
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