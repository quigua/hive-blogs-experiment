// netlify/functions/get-user-posts.js
const Redis = require('ioredis');
const fetch = require('node-fetch');

let redisClient = null;

function isOldPost(createdDate) {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    return new Date(createdDate) < sevenDaysAgo;
}

exports.handler = async (event, context) => {
    // Aumentamos el timeout para dar más margen a las múltiples llamadas si son necesarias.
    // 25 segundos es un buen límite para Netlify Functions (máx 26s).
    const timeoutPromise = new Promise((resolve, reject) => {
        setTimeout(() => {
            reject(new Error('Function execution timed out before completing.'));
        }, 25000); // 25 segundos
    });

    try {
        if (!redisClient || redisClient.status === 'end' || redisClient.status === 'wait') {
            console.log('[ioredis] Initializing or re-establishing Redis connection...');
            const redisUrl = process.env.UPSTASH_REDIS_URL;
            const redisPassword = process.env.UPSTASH_REDIS_PASSWORD;

            if (!redisUrl) {
                console.error("ERROR: UPSTASH_REDIS_URL is not configured.");
                return { statusCode: 500, body: JSON.stringify({ error: 'Missing Redis URL configuration.' }) };
            }
            if (!redisPassword) {
                console.error("ERROR: UPSTASH_REDIS_PASSWORD is not configured.");
                return { statusCode: 500, body: JSON.stringify({ error: 'Missing Redis Password configuration.' }) };
            }

            redisClient = new Redis(redisUrl, { password: redisPassword, tls: {} });

            if (!redisClient.__listenersAttached) {
                redisClient.on('error', (err) => console.error('[ioredis] Connection or operation error:', err.message, err.code, err.address));
                redisClient.on('connect', () => console.log('[ioredis] Connected to Redis!'));
                redisClient.on('reconnecting', () => console.warn('[ioredis] Reconnecting to Redis...'));
                redisClient.on('end', () => { console.warn('[ioredis] Redis connection terminated. Resetting client.'); redisClient = null; });
                redisClient.__listenersAttached = true;
            }
        }

        const { username, limit, start_author, start_permlink, contentType = 'posts' } = event.queryStringParameters;
        const parsedLimit = parseInt(limit); // Cuántos posts filtrados queremos devolver

        if (!username || !parsedLimit) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing parameters: username or limit.' }) };
        }

        const hiveNodes = [
            'https://api.hive.blog',
            'https://api.deathwing.me',
            'https://api.pharesim.me'
        ];

        const cacheKey = `hive:${contentType}:${username}:${parsedLimit}:${start_author || 'null'}:${start_permlink || 'null'}`;

        let cachedResponse = null;
        try {
            cachedResponse = await Promise.race([redisClient.get(cacheKey), timeoutPromise]);
        } catch (redisErr) {
            console.error(`Error trying to get from Redis for ${cacheKey}:`, redisErr);
        }

        if (cachedResponse) {
            console.log(`Cache HIT for key: ${cacheKey}`);
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: cachedResponse,
            };
        }
        console.log(`Cache MISS for key: ${cacheKey}. Fetching from Hive.`);

        // --- Lógica de BUCLE para obtener suficientes posts FILTRADOS ---
        const postsToFetchPerCall = 20; // ¡Mantener en 20, ya que es el límite de Hive!
        let collectedFilteredItems = [];
        let currentHiveStartAuthor = start_author;
        let currentHiveStartPermlink = start_permlink;
        let hiveHasMore = true;
        let maxIterations = 5; // Limitar el número de llamadas a Hive (20 * 5 = 100 posts brutos máximo)

        while (collectedFilteredItems.length < parsedLimit && hiveHasMore && maxIterations > 0) {
            maxIterations--;
            console.log(`[LOOP] Iteration ${5 - maxIterations}. Current filtered: ${collectedFilteredItems.length}. Fetching from Hive node...`);
            
            const body = {
                jsonrpc: '2.0',
                id: 1,
                method: 'condenser_api.get_discussions_by_blog',
                params: [{
                    tag: username,
                    limit: postsToFetchPerCall,
                    start_author: currentHiveStartAuthor || undefined,
                    start_permlink: currentHiveStartPermlink || undefined,
                }],
            };

            let hiveResponse;
            let hiveError = null;

            for (const nodeUrl of hiveNodes) {
                try {
                    hiveResponse = await Promise.race([
                        fetch(nodeUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(body),
                        }),
                        timeoutPromise
                    ]);

                    if (hiveResponse.ok) {
                        hiveError = null;
                        break;
                    } else {
                        const errorText = await hiveResponse.text();
                        hiveError = new Error(`Hive API error at ${nodeUrl}: ${hiveResponse.status} - ${errorText}`);
                        console.error(hiveError.message);
                    }
                } catch (error) {
                    hiveError = new Error(`Network error connecting to ${nodeUrl}: ${error.message}`);
                    console.error(hiveError.message);
                }
            }

            if (!hiveResponse || !hiveResponse.ok) {
                console.error("Failed to fetch from any Hive node in loop. Breaking.");
                hiveHasMore = false;
                if (collectedFilteredItems.length === 0) {
                    throw hiveError || new Error('Could not connect to any Hive node during data collection.');
                }
                break;
            }

            const hiveData = await hiveResponse.json();

            if (hiveData.error) {
                console.error('Hive error during loop:', hiveData.error);
                hiveHasMore = false;
                if (collectedFilteredItems.length === 0) {
                    return { statusCode: 500, body: JSON.stringify({ error: 'Hive API error during data collection', details: hiveData.error }) };
                }
                break;
            }

            const currentFetchedItems = hiveData.result || [];
            if (currentFetchedItems.length === 0) {
                hiveHasMore = false; // No hay más posts en el blog de Hive
                break;
            }

            // Actualizar la paginación para la siguiente llamada a Hive
            const lastItemFromHiveBatch = currentFetchedItems[currentFetchedItems.length - 1];
            currentHiveStartAuthor = lastItemFromHiveBatch.author;
            currentHiveStartPermlink = lastItemFromHiveBatch.permlink;
            
            // Si el primer item del lote actual es el mismo que el start_permlink de esta llamada,
            // y no es la primera llamada, significa que Hive nos devolvió el mismo post inicial.
            // Lo saltamos para evitar duplicados en `collectedFilteredItems`.
            // Esto es crucial para `condenser_api.get_discussions_by_blog` que incluye el start_permlink.
            if (start_author && start_permlink && 
                currentFetchedItems[0].author === start_author && 
                currentFetchedItems[0].permlink === start_permlink && 
                collectedFilteredItems.length === 0) { // Solo si es la primera vez que se está intentando recoger.
                // En el primer llamado del bucle, si ya pasamos start_author/permlink,
                // Hive puede incluirlo. Si ya hemos recogido items, esto no se aplicaría.
                // Esta bandera `skippedInitialDuplicate` es más útil si está fuera del bucle
                // para la primera llamada de la *función completa*, no de cada iteración del bucle.
                // Sin embargo, para esta lógica de bucle, la clave es asegurar que el `slice(1)`
                // se aplica solo si el primer elemento del lote coincide con el inicio de la búsqueda.
                // La forma más robusta es que cada vez que se haga una llamada,
                // si el primer elemento coincide con el `start_author`/`start_permlink` de esa **misma llamada**,
                // lo saltemos para no procesar duplicados *dentro de este bucle*.
                 if (currentHiveStartAuthor === start_author && currentHiveStartPermlink === start_permlink) {
                     itemsToFilter = currentFetchedItems.slice(1);
                 } else {
                     itemsToFilter = currentFetchedItems;
                 }
            } else {
                itemsToFilter = currentFetchedItems;
            }

            // Aplicar el filtro según el contentType
            for (const item of itemsToFilter) {
                if (contentType === 'posts') {
                    if (item.author === username && (!item.reblogged_by || item.reblogged_by.length === 0)) {
                        collectedFilteredItems.push(item);
                    }
                } else if (contentType === 'reblogs') {
                    // Filtro para reblogs: debe tener reblogged_by (y ser array), debe contener al username,
                    // Y ¡CRUCIAL! el autor de la publicación NO debe ser el username.
                    if (item.reblogged_by && Array.isArray(item.reblogged_by) && item.reblogged_by.includes(username) && item.author !== username) {
                         collectedFilteredItems.push(item);
                    }
                }
            }
            
            // Si Hive devolvió menos del límite que le pedimos, significa que no hay más en el feed bruto.
            if (currentFetchedItems.length < postsToFetchPerCall) {
                hiveHasMore = false;
            }
        } // Fin del bucle while

        // --- Preparar la respuesta final ---
        const postsToSend = collectedFilteredItems.slice(0, parsedLimit);
        
        let finalHasMore = true; 
        // Determinamos hasMore:
        // 1. Si no obtuvimos suficientes posts filtrados para llenar `parsedLimit`
        // Y Hive ya no tiene más posts en su feed bruto (hiveHasMore es false),
        // entonces no hay más.
        if (collectedFilteredItems.length < parsedLimit && !hiveHasMore) {
            finalHasMore = false;
        } else if (collectedFilteredItems.length >= parsedLimit) {
             // Si ya tenemos suficientes posts filtrados para esta carga, y potencialmente más,
             // asumimos que hay más.
             finalHasMore = true;
        } else if (collectedFilteredItems.length === 0 && !hiveHasMore) {
            // Si no encontramos ningún post filtrado y Hive ya no tiene más posts brutos,
            // entonces no hay más.
            finalHasMore = false;
        } else if (maxIterations === 0 && collectedFilteredItems.length < parsedLimit) {
            // Si alcanzamos el máximo de iteraciones y no conseguimos suficientes posts,
            // pero Hive podría tener más, la bandera `finalHasMore` debería ser true para que el cliente lo intente de nuevo.
            finalHasMore = true;
        }


        // La paginación para la siguiente llamada del cliente siempre debe basarse en el
        // último punto de avance de Hive (currentHiveStartAuthor/permlink),
        // para que la próxima búsqueda empiece donde la última se detuvo en el feed bruto de Hive.
        let nextClientStartAuthor = currentHiveStartAuthor;
        let nextClientStartPermlink = currentHiveStartPermlink;

        // Caso especial: si hemos enviado exactamente `parsedLimit` posts,
        // pero Hive aún tiene más que darnos (hiveHasMore es true),
        // mantenemos la paginación de Hive como está.
        // Si no hemos logrado enviar el parsedLimit, o si el collectedFilteredItems es <= parsedLimit,
        // Y Hive YA NO TIENE MÁS (hiveHasMore es false), entonces no hay más posts.
        if (collectedFilteredItems.length === 0 && !hiveHasMore) {
            finalHasMore = false; // Realmente no hay más.
            nextClientStartAuthor = null;
            nextClientStartPermlink = null;
        } else if (postsToSend.length === 0 && finalHasMore) {
            // Si no hay posts para enviar en este lote, pero finalHasMore es true,
            // significa que el cliente debe intentar cargar de nuevo desde el mismo `nextClientStart`
            // hasta que se encuentren suficientes posts filtrados. Esto es importante.
            // currentHiveStartAuthor/currentHiveStartPermlink ya tienen el valor correcto.
        } else if (postsToSend.length < parsedLimit && !hiveHasMore) {
            // Si enviamos menos de `parsedLimit` y ya no hay más de Hive, entonces no hay más.
            finalHasMore = false;
            nextClientStartAuthor = null;
            nextClientStartPermlink = null;
        }

        const responseData = {
            posts: postsToSend,
            nextStartAuthor: nextClientStartAuthor,
            nextStartPermlink: nextClientStartPermlink,
            hasMore: finalHasMore,
        };

        // Caché de la respuesta
        if (postsToSend.length > 0) {
            const cacheDuration = postsToSend.every(item => isOldPost(item.created)) ? 60 * 60 * 24 * 30 : 60 * 5;
            try {
                await Promise.race([redisClient.set(cacheKey, JSON.stringify(responseData), 'EX', cacheDuration), timeoutPromise]);
                console.log(`Cache SET for key: ${cacheKey} (${contentType} filtered, duration: ${cacheDuration / 60} min).`);
            } catch (redisErr) {
                console.error(`Error trying to save to Redis ${cacheKey}:`, redisErr);
            }
        } else if (!finalHasMore) {
             try {
                await Promise.race([redisClient.set(cacheKey, JSON.stringify(responseData), 'EX', 60 * 60 * 24 * 7), timeoutPromise]); // 7 días para 'no hay más'
                console.log(`Cache SET for key: ${cacheKey} (No more items, duration: 7 days).`);
             } catch (redisErr) {
                console.error(`Error trying to save 'no more items' to Redis ${cacheKey}:`, redisErr);
             }
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(responseData),
        };

    } catch (error) {
        console.error('Error in get-user-posts function (caught):', error.message, error.stack);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Internal server error', details: error.message }),
        };
    } finally {
        // No llamamos a redisClient.quit() aquí, permitiendo la reutilización de la conexión.
    }
};