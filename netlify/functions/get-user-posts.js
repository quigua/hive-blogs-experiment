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
                startPermlink,
                '',
                fetchBatchSize
            );

            let postsToAdd = discussions;
            if (startPermlink && discussions.length > 0 && discussions[0].permlink === startPermlink) {
                postsToAdd = discussions.slice(1);
            }

            if (postsToAdd.length === 0) {
                hasMore = false;
                break;
            }

            // --- Depuración: Imprimir la estructura del primer post recibido ---
            if (count === 0 && postsToAdd.length > 0) {
                console.log("--- Estructura del primer post recibido de Hive ---");
                console.log(JSON.stringify(postsToAdd[0], null, 2));
                console.log("---------------------------------------------------");
            }
            // ------------------------------------------------------------------

            for (const post of postsToAdd) {
                if (count < limit) {
                    // Asegurarse de que las propiedades existen y se acceden correctamente
                    // Utilizaremos un enfoque más defensivo y verficaremos las propiedades.
                    const title = post.title || 'Sin título';
                    const body = post.body || '';
                    const permlink = post.permlink || '';
                    const author = post.author || username; 

                    // Aquí nos aseguramos de que la URL se construye correctamente con backticks
                    const postUrl = `https://hive.blog/@<span class="math-inline">\{author\}/</span>{permlink}`;

                    posts.push({
                        id: post.id,
                        author: author,
                        permlink: permlink,
                        title: title,
                        summary: body.substring(0, 200) + (body.length > 200 ? '...' : ''),
                        created: post.created,
                        url: postUrl, 
                        body: body 
                    });
                    count++;
                } else {
                    break;
                }
            }

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