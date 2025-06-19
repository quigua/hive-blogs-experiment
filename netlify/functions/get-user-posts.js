// netlify/functions/get-user-posts.js
// ... (código existente hasta hiveNodes) ...

        const hiveNodes = [
            'https://api.hive.blog', // Primero intenta con este (más común y estable)
            'https://api.deathwing.me',
            'https://api.pharesim.me' // Este es el que está dando problemas
        ];
        // Quita la línea: const randomNode = hiveNodes[Math.floor(Math.random() * hiveNodes.length)];

        // ... (código existente hasta el if (cachedResponse)) ...
       
        if (cachedResponse) {
            console.log(`Cache HIT para clave: ${cacheKey}`);
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: cachedResponse,
            };
        }
        console.log(`Cache MISS para clave: ${cacheKey}. Fetching from Hive.`);

        const body = {
            jsonrpc: '2.0',
            id: 1,
            method: 'condenser_api.get_discussions_by_blog',
            params: [{
                tag: username,
                limit: parseInt(limit), 
                start_author: start_author || undefined,
                start_permlink: start_permlink || undefined,
            }],
        };

        let hiveResponse;
        let hiveError = null;

        // --- Bucle para intentar con diferentes nodos de Hive ---
        for (const nodeUrl of hiveNodes) {
            console.log(`Intentando fetch con nodo Hive: ${nodeUrl}`);
            try {
                hiveResponse = await Promise.race([
                    fetch(nodeUrl, { // Usa el nodo actual del bucle
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                    }),
                    timeoutPromise 
                ]);

                if (hiveResponse.ok) {
                    hiveError = null; // Si es exitoso, limpia cualquier error previo
                    break; // Sal del bucle si la respuesta es OK
                } else {
                    const errorText = await hiveResponse.text();
                    hiveError = new Error(`Error de la API de Hive en ${nodeUrl}: ${hiveResponse.status} - ${errorText}`);
                    console.error(hiveError.message);
                }
            } catch (error) {
                hiveError = new Error(`Error de red al conectar con ${nodeUrl}: ${error.message}`);
                console.error(hiveError.message);
            }
        }
        // --- Fin del bucle de reintentos ---

        if (!hiveResponse || !hiveResponse.ok) { // Si después de todos los reintentos no hubo una respuesta exitosa
            throw hiveError || new Error('No se pudo conectar a ningún nodo de Hive.');
        }

        const hiveData = await hiveResponse.json();

        // ... (el resto del código de la función permanece igual) ...