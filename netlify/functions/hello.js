// netlify/functions/hello.js
exports.handler = async (event, context) => {
    return {
        statusCode: 200,
        body: JSON.stringify({ message: "¡Hola desde una Netlify Function!" }),
    };
};