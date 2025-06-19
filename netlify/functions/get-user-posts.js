// netlify/functions/get-user-posts.js

// ... (código existente hasta la definición de body para Hive) ...

        const body = {
            jsonrpc: '2.0',
            id: 1,
            method: 'condenser_api.get_discussions_by_blog',
            params: [{
                tag: username,
                // --- CAMBIO CLAVE: Pedimos más posts de Hive para tener suficientes después del filtrado ---
                limit: parseInt(limit) + 5, // Pedimos 5 extra, ajusta si es necesario
                start_author: start_author || undefined,
                start_permlink: start_permlink || undefined,
            }],
        };

// ... (resto del código hasta la definición de finalItems) ...

        const allFetchedItems = hiveData.result || [];

        let filteredItems = []; // Renombrado para evitar confusión
        if (contentType === 'posts') {
            filteredItems = allFetchedItems.filter(item => !item.reblogged_by || item.reblogged_by.length === 0);
        } else if (contentType === 'reblogs') {
            filteredItems = allFetchedItems.filter(item => item.reblogged_by && item.reblogged_by.length > 0);
        } else {
            filteredItems = allFetchedItems; 
        }

        // --- CAMBIO CLAVE: Tomar solo los 10 primeros items *después* del filtrado ---
        // Y asegurarnos de que si el primer item es el start_permlink, lo descartamos
        // ya que Hive lo incluye como el primer elemento del siguiente "slice"
        let finalItems = [];
        if (start_author && start_permlink && filteredItems.length > 0 && 
            filteredItems[0].author === start_author && 
            filteredItems[0].permlink === start_permlink) {
            finalItems = filteredItems.slice(1, parseInt(limit) + 1); // Cortar el primero y luego 10
        } else {
            finalItems = filteredItems.slice(0, parseInt(limit)); // Tomar los primeros 10
        }
        
        // La lógica de caché ahora usa finalItems
        const allItemsAreOld = finalItems.every(item => isOldPost(item.created));

        if (allItemsAreOld && finalItems.length > 0) { 
            try {
                await Promise.race([redisClient.set(cacheKey, JSON.stringify({ posts: finalItems }), 'EX', 60 * 60 * 24 * 30), timeoutPromise]); 
                console.log(`Cache SET para clave: ${cacheKey} (${contentType} viejos, filtrados).`);
            } catch (redisErr) {
                console.error(`Error al intentar guardar en Redis (${contentType} viejos) ${cacheKey}:`, redisErr);
            }
        } else if (finalItems.length > 0) { 
            try {
                await Promise.race([redisClient.set(cacheKey, JSON.stringify({ posts: finalItems }), 'EX', 60 * 5), timeoutPromise]); 
                console.log(`Cache SET para clave: ${cacheKey} (${contentType} recientes, filtrados).`);
            } catch (redisErr) {
                console.error(`Error al intentar guardar en Redis (${contentType} recientes) ${cacheKey}:`, redisErr);
            }
        }
        
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ posts: finalItems }), // Devuelve los ítems filtrados y limitados
        };

// ... (resto del código) ...