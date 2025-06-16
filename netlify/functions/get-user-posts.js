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
    let hasMore = true;
    const fetchBatchSize = 100;

    try {
        while (hasMore && allUserPosts.length < limit) {
            const query = {
                tag: username,
                limit: fetchBatchSize,
            };

            if (startAuthor && startPermlink) {
                query.start_author = startAuthor;
                query.start_permlink = startPermlink;
            }

            const postsBatch = await hive.api.getDiscussionsByBlogAsync(query);

            // Remover el duplicado de paginación si existe
            if (postsBatch.length > 0 && startAuthor && startPermlink && 
                postsBatch[0].author === startAuthor && postsBatch[0].permlink === startPermlink) {
                postsBatch.shift(); 
            }

            if (postsBatch.length === 0) {
                hasMore = false;
                break;
            }

            for (const post of postsBatch) {
                // Validar la existencia de propiedades clave
                if (!post.author || !post.permlink || !post.title || !post.body || !post.created) {
                    console.warn(`Post incompleto o malformado, saltando: ${JSON.stringify(post)}`);
                    continue; 
                }

                // Construcción segura de la URL usando post.author y post.permlink
                const fullUrl = `https://hive.blog/@<span class="math-inline">\{post\.author\}/</span>{post.permlink}`;

                const postObj = {
                    id: post.id,
                    author: post.author,
                    permlink: post.permlink,
                    title: post.title,
                    summary: post.body.substring(0, 200) + (post.body.length > 200 ? '...' : ''),
                    created: post.created,
                    url: fullUrl, // Usamos la URL completa que acabamos de construir
                    body: post.body 
                };

                if (post.author === username) {
                    // Es una publicación original del usuario
                    allUserPosts.push(postObj);
                } else {
                    // Es un reblog
                    reblogs.push({
                        ...postObj,
                        reblogged_by: username 
                    });
                }

                if (allUserPosts.length >= limit) {
                    break; 
                }
            }

            // Actualizar los parámetros de paginación
            if (postsBatch.length > 0) {
                const lastPostInBatch = postsBatch[postsBatch.length - 1];
                startAuthor = lastPostInBatch.author;
                startPermlink = lastPostInBatch.permlink;
            } else {
                hasMore = false;
            }

            if (postsBatch.length < fetchBatchSize) {
                hasMore = false;
            }
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                username: username,
                posts: allUserPosts, 
                reblogs: reblogs,   
                hasMore: hasMore,
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