// netlify/functions/get-hive-info.js
const hive = require('@hiveio/hive-js');

exports.handler = async (event, context) => {
    try {
        // Establece un nodo RPC de Hive. Puedes cambiarlo a uno más cercano o de tu preferencia.
        hive.api.set
        Options({ url: 'https://api.hive.blog' });

        // Ejemplo: Obtener el número del bloque más reciente
        const dynamicGlobalProperties = await hive.api.getDynamicGlobalPropertiesAsync();
        const headBlockNumber = dynamicGlobalProperties.head_block_number;

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: "Información de la blockchain de Hive obtenida con éxito.",
                headBlockNumber: headBlockNumber,
                nodeUsed: hive.api.options.url // Muestra qué nodo se usó
            }),
        };
    } catch (error) {
        console.error("Error al obtener información de Hive:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Error al comunicarse con la blockchain de Hive.", details: error.message }),
        };
    }
};