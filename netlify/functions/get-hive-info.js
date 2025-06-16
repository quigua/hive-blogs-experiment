// netlify/functions/get-hive-info.js
const hive = require('@hiveio/hive-js');

exports.handler = async (event, context) => {
    try {
        // Establece el nodo RPC de Hive directamente en la configuración
        // La propiedad correcta es 'url' en hive.config
        hive.config.set('websocket', 'https://api.hive.blog'); 

        // Ejemplo: Obtener el número del bloque más reciente
        const dynamicGlobalProperties = await hive.api.getDynamicGlobalPropertiesAsync();
        const headBlockNumber = dynamicGlobalProperties.head_block_number;

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: "Información de la blockchain de Hive obtenida con éxito.",
                headBlockNumber: headBlockNumber,
                nodeUsed: hive.config.get('websocket') // Muestra qué nodo se usó desde la configuración
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