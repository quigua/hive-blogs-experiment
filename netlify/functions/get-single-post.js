// netlify/functions/get-single-post.js
const hive = require('@hiveio/hive-js');

exports.handler = async (event, context) => {
    // Asegurarse de que el websocket está configurado
    hive.config.set('websocket', 'https://api.hive.blog');
    console.log("Configuración de Hive.js: websocket a https://api.hive.blog");

    const author = event.queryStringParameters.author;
    const permlink = event.queryStringParameters.permlink;

    // Validar que se recibieron los parámetros necesarios
    if (!author || !permlink) {
        console.error("Faltan parámetros 'author' o 'permlink' para get-single-post.");
        return {
            statusCode: 400,
            body: JSON.stringify({ error: "Faltan los parámetros 'author' y 'permlink' en la solicitud." }),
        };
    }

    console.log(`Buscando post para author: ${author}, permlink: ${permlink}`);

    try {
        // hive.api.getDiscussionsByPermlinkAsync es ideal para un solo post
        // El primer parámetro es el autor, el segundo el permlink
        const postData = await hive.api.getDiscussionsByPermlinkAsync(author, permlink);

        // getDiscussionsByPermlinkAsync debería devolver un solo objeto de post si lo encuentra
        if (!postData) {
            console.warn(`No se encontró el post para author: ${author}, permlink: ${permlink}`);
            return {
                statusCode: 404,
                body: JSON.stringify({ error: "Post no encontrado." }),
            };
        }

        // Construcción segura de la URL usando post.author y post.permlink
        const fullUrl = `https://hive.blog/@<span class="math-inline">\{postData\.author\}/</span>{postData.permlink}`;

        const singlePost = {
            id: postData.id,
            author: postData.author,
            permlink: postData.permlink,
            title: postData.title,
            body: postData.body, // El cuerpo completo del post
            created: postData.created,
            url: fullUrl,
            // Puedes añadir más propiedades si las necesitas de postData, como:
            // votes: postData.active_votes,
            // json_metadata: JSON.parse(postData.json_metadata || '{}'),
            // category: postData.category
        };

        console.log(`Post encontrado y procesado: ${singlePost.permlink}`);

        return {
            statusCode: 200,
            body: JSON.stringify(singlePost),
        };

    } catch (error) {
        console.error("Error al obtener el post de Hive:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Error al comunicarse con la blockchain de Hive para obtener el post.", details: error.message }),
        };
    }
};