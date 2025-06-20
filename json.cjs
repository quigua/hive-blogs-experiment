const https = require('https');
const fs = require('fs');

const RPC_ENDPOINT = 'https://api.hive.blog'; // O cualquier nodo Hive que prefieras

const requestData = JSON.stringify({
  jsonrpc: '2.0',
  method: 'condenser_api.get_discussions_by_blog', // Este es el método que queremos usar
  params: [{
    tag: 'hive', // Puedes cambiar 'hive' por el tag del blog que te interese, por ejemplo, 'quigua'
    limit: 10   // Un límite bajo es suficiente para obtener la estructura
  }],
  id: 1
});

const options = {
  hostname: new URL(RPC_ENDPOINT).hostname,
  port: 443,
  path: new URL(RPC_ENDPOINT).pathname,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': requestData.length
  }
};

const req = https.request(options, (res) => {
  let responseBody = '';

  res.on('data', (chunk) => {
    responseBody += chunk;
  });

  res.on('end', () => {
    try {
      const jsonResponse = JSON.parse(responseBody);
      const outputFile = 'get_discussions_by_blog_structure.json';

      // Guarda el JSON completo en un archivo
      fs.writeFile(outputFile, JSON.stringify(jsonResponse, null, 2), (err) => {
        if (err) {
          console.error('Error al escribir el archivo:', err);
        } else {
          console.log(`Estructura JSON guardada en ${outputFile}`);
          console.log('\nRecuerda que para ver la estructura, puedes abrir el archivo y analizar sus campos.');
          console.log('El campo "result" contendrá un array de objetos de publicaciones.');
        }
      });

    } catch (parseError) {
      console.error('Error al parsear la respuesta JSON:', parseError);
      console.error('Respuesta recibida:', responseBody);
    }
  });
});

req.on('error', (e) => {
  console.error(`Problema con la solicitud: ${e.message}`);
});

req.write(requestData);
req.end();