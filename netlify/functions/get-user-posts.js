// netlify/functions/get-user-posts.js
const hive = require('@hiveio/hive-js');

exports.handler = async (event, context) => {
    // Asegurarse de que el websocket está configurado
    // *** IMPORTANTE: REEMPLAZA 'TU_DOMINIO_PERSONALIZADO.COM' CON TU DOMINIO REAL ***
    const BASE_BLOG_URL = 'https://dreamy-baklava-d17cb6.netlify.app';
    hive.config.set('websocket', 'https://api.hive.blog');
    console.log("Configuración de Hive.js: websocket a https://api.hive.blog");

    const username = event.queryStringParameters.username || 'quigua';
    const limit = parseInt(event.queryStringParameters.limit) || 20;
    let startAuthor = event.queryStringParameters.start_author || null;
    let startPermlink = event.queryStringParameters.start_permlink || null;

    const allUserPosts = [];
    const reblogs = [];
    let hasMore = true;
    const fetchBatchSize = 20; // Reducido temporalmente para depuración, para ver si afecta la respuesta inicial

    console.log(`Iniciando búsqueda para usuario: ${username}, límite: ${limit}`);
    console.log(`Paginación inicial: startAuthor=<span class="math-inline">\{startAuthor\}, startPermlink\=</span>{startPermlink}`);

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

            console.log("Consulta enviada a Hive API:", JSON.stringify(query));

            const postsBatch = await hive.api.getDiscussionsByBlogAsync(query);
            console.log(`Posts recibidos en el batch (postsBatch.length): ${postsBatch.length}`);

            // Si la primera publicación del batch es la misma que la última de la iteración anterior (duplicado por paginación),
            // la quitamos. Esto pasa si start_author/permlink son el último item del batch anterior.
            if (postsBatch.length > 0 && startAuthor && startPermlink && 
                postsBatch[0].author === startAuthor && postsBatch[0].permlink === startPermlink) {
                postsBatch.shift(); 
                console.log("Se eliminó un post duplicado del batch.");
            }

            if (postsBatch.length === 0) {
                console.log("El batch de posts está vacío después de eliminar duplicados. Terminando.");
                hasMore = false; // No hay más publicaciones en absoluto o ya hemos procesado todas
                break;
            }

            // --- Depuración CRUCIAL: Imprimir la estructura del primer post recibido si hay alguno ---
            if (postsBatch.length > 0) {
                console.log("--- Estructura del PRIMER POST recibido en este batch ---");
                // Usamos JSON.stringify para asegurar que se muestre todo el objeto
                console.log(JSON.stringify(postsBatch[0], null, 2)); 
                console.log("-------------------------------------------------------");
            } else {
                console.log("No hay posts en el batch después de la eliminación de duplicados para depurar.");
            }
            // ----------------------------------------------------------------------------------

            let processedInBatch = 0;
            for (const post of postsBatch) {
                // Validar la existencia de propiedades clave
                if (!post.author || !post.permlink || !post.title || !post.body || !post.created) {
                    console.warn(`Post incompleto o malformado, saltando: ${JSON.stringify(post)}`);
                    continue; 
                }

                // Construcción segura de la URL usando post.author y post.permlink
                const fullUrl = `${BASE_BLOG_URL}/@${post.author}/${post.permlink}`;
                console.log(`URL construida para el post ${post.permlink}: ${fullUrl}`);
                
                

                const postObj = {
                    id: post.id,
                    author: post.author,
                    permlink: post.permlink,
                    title: post.title,
                    summary: post.body.substring(0, 200) + (post.body.length > 200 ? '...' : ''),
                    created: post.created,
                    url: fullUrl,
                    body: post.body 
                };

                if (post.author === username) {
                    // Es una publicación original del usuario
                    allUserPosts.push(postObj);
                    console.log(`Añadido post original: ${post.permlink}. Total originales: ${allUserPosts.length}`);
                } else {
                    // Es un reblog
                    reblogs.push({
                        ...postObj,
                        reblogged_by: username 
                    });
                    console.log(`Añadido reblog: ${post.permlink}. Total reblogs: ${reblogs.length}`);
                }
                processedInBatch++;

                if (allUserPosts.length >= limit) {
                    console.log(`Alcanzado límite de ${limit} posts originales. Saliendo del bucle interno.`);
                    break; 
                }
            }
            console.log(`Posts procesados en este batch: ${processedInBatch}`);


            // Actualizar los parámetros de paginación para la siguiente iteración
            // Esto debe ser el último post del batch, no el último original
            if (postsBatch.length > 0) {
                const lastPostInBatch = postsBatch[postsBatch.length - 1];
                startAuthor = lastPostInBatch.author;
                startPermlink = lastPostInBatch.permlink;
                console.log(`Actualizando paginación: startAuthor=<span class="math-inline">\{startAuthor\}, startPermlink\=</span>{startPermlink}`);
            } else {
                hasMore = false; // No hay más publicaciones si el batch está vacío
                console.log("Batch vacío, estableciendo hasMore a false.");
            }

            // Si el número de posts en el batch es menor que el tamaño del batch solicitado,
            // significa que no hay más publicaciones, a menos que el batch sea exacto y queden más.
            // Ajustamos esta lógica para ser más robusta. Si el `allUserPosts.length` alcanza el `limit`
            // o si el `postsBatch` fue menor que `fetchBatchSize` (y no es la primera llamada),
            // o si el `postsBatch` está vacío.
            if (allUserPosts.length >= limit || postsBatch.length < fetchBatchSize) {
                hasMore = false;
                console.log("Condición de fin de paginación alcanzada. hasMore = false.");
            }
        }

        console.log("Bucle de paginación terminado.");
        console.log(`Resultado final: Posts originales encontrados: ${allUserPosts.length}, Reblogs encontrados: ${reblogs.length}`);

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