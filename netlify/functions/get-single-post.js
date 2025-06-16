// netlify/functions/get-single-post.js
const hive = require('@hiveio/hive-js');

exports.handler = async (event, context) => {
    // *** IMPORTANTE: REEMPLAZA 'TU_DOMINIO_PERSONALIZADO.COM' CON TU DOMINIO REAL ***
    const BASE_BLOG_URL = 'https://dreamy-baklava-d17cb6.netlify.app';
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
        // *** CORRECCIÓN APLICADA AQUÍ: Usando getContentAsync ***
        const postData = await hive.api.getContentAsync(author, permlink);

        // getContentAsync devuelve un objeto vacío si no encuentra el post, no null
        if (!postData || Object.keys(postData).length === 0 || postData.id === 0) {
            console.warn(`No se encontró el post o el post está vacío para author: ${author}, permlink: ${permlink}`);
            return {
                statusCode: 404,
                body: JSON.stringify({ error: "Post no encontrado o contenido vacío." }),
            };
        }

        // Construcción segura de la URL
        const fullUrl = `${BASE_BLOG_URL}/@${postData.author}/${postData.permlink}`;
        
        

        const singlePost = {
            id: postData.id,
            author: postData.author,
            permlink: postData.permlink,
            title: postData.title,
            body: postData.body, // El cuerpo completo del post
            created: postData.created,
            url: fullUrl,
            // Puedes añadir más propiedades si las necesitas de postData
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