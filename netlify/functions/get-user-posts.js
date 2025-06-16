// netlify/functions/get-user-posts.js
const hive = require('@hiveio/hive-js');

exports.handler = async (event, context) => {
    // Establece un nodo RPC de Hive
    hive.api.setOptions({ url: 'https://api.hive.blog' });

    // Extrae el nombre de usuario de los parámetros de la URL
    const username = event.queryStringParameters.username || 'quigua'; // Por defecto 'quigua' si no se especifica

    try {
        // Obtiene las publicaciones de un usuario
        // 'blog' es un tipo de feed que muestra las publicaciones de un usuario en orden cronológico inverso
        // El segundo parámetro (limit) puede ajustarse para obtener más o menos publicaciones
        const posts = await hive.api.getDiscussionsByBlogAsync({ tag: username, limit: 10 });

        // Filtra y formatea los datos de las publicaciones
        const formattedPosts = posts.map(post => ({
            id: post.id,
            author: post.author,
            permlink: post.permlink,
            title: post.title,
            summary: post.body.substring(0, 200) + '...', // Pequeño resumen del contenido
            created: post.created,
            url: `https://hive.blog/@<span class="math-inline">\{post\.author\}/</span>{post.permlink}`
        }));

        return {
            statusCode: 200,
            body: JSON.stringify({
                username: username,
                posts: formattedPosts
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