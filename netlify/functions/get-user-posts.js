// netlify/functions/get-user-posts.js
const hive = require('@hiveio/hive-js');

exports.handler = async (event, context) => {
    hive.config.set('websocket', 'https://api.hive.blog');

    const username = event.queryStringParameters.username || 'quigua';
    const limit = parseInt(event.queryStringParameters.limit) || 20; // Límite de publicaciones a retornar
    const startPermlink = event.queryStringParameters.start_permlink || null;
    const startAuthor = event.queryStringParameters.start_author || null; // No usado directamente con este método pero se mantiene para consistencia

    const posts = [];
    let hasMore = true;
    let count = 0;
    const fetchBatchSize = 100; // Cuántas publicaciones pedir en cada llamada
    let lastPermlink = startPermlink; // Usar para paginación

    try {
        // Este método busca discusiones (posts) por autor ANTES de una fecha/permlink dado.
        // Es más adecuado para obtener publicaciones originales de un autor.
        while (hasMore && count < limit) {
            const discussions = await hive.api.getDiscussionsByAuthorBeforeDateAsync(
                username,
                lastPermlink, // Si es null, empieza desde las más recientes
                '', // fecha: vacío para que use el permlink como punto de inicio
                fetchBatchSize
            );

            // Si no hay discusiones, o solo trajo el elemento de inicio de la iteración anterior,
            // significa que no hay más publicaciones.
            if (discussions.length === 0 || (discussions.length === 1 && discussions[0].permlink === lastPermlink)) {
                hasMore = false;
                break;
            }

            // Filtrar el duplicado si estamos en paginación
            const postsToAdd = lastPermlink ? discussions.slice(1) : discussions;

            for (const post of postsToAdd) {
                if (count < limit) {
                    posts.push({
                        id: post.id,
                        author: post.author,
                        permlink: post.permlink,
                        title: post.title,
                        summary: post.body ? post.body.substring(0, 200) + (post.body.length > 200 ? '...' : '') : '',
                        created: post.created,
                        url: `https://hive.blog/@<span class="math-inline">\{post\.author\}/</span>{post.permlink}`, // URL CORRECTA
                        body: post.body // Incluir el cuerpo completo
                    });
                    count++;
                } else {
                    break;
                }
            }

            if (postsToAdd.length < fetchBatchSize || count >= limit) {
                hasMore = false;
            } else {
                lastPermlink = postsToAdd[postsToAdd.length - 1].permlink;
            }
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                username: username,
                posts: posts, // Esto ahora solo contendrá publicaciones originales
                reblogs: [], // No podemos obtener reblogs con este método directamente, se dejará vacío por ahora
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