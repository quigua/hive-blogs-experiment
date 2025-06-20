---
// src/pages/index.astro
import PostCard from '../components/PostCard.astro';
import '../styles/global.css';

const FUNCTIONS_BASE_URL = 'https://dreamy-baklava-d17cb6.netlify.app/.netlify/functions';
const USERNAME_TO_FETCH = 'quigua';
const POSTS_PER_PAGE = 10;

// --- Carga inicial de posts (Originales) en el servidor (Astro) ---
// NOTA: Esta sección no cambia y seguirá cargando posts originales como antes.
// El nuevo comportamiento de debug solo afectará a la pestaña 'reblogs' a través del JS del cliente.
let initialPosts = [];
let initialPostsNextStartAuthor = '';
let initialPostsNextStartPermlink = '';
let initialPostsHasMore = true;

const hiveNodes = [
    'https://api.hive.blog',
    'https://api.deathwing.me',
    'https://api.pharesim.me'
];

try {
    let hiveData = null;
    let fetchError = null;
    const requestLimitToHive = 20;

    for (const nodeUrl of hiveNodes) {
        try {
            const response = await fetch(nodeUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'condenser_api.get_discussions_by_blog',
                    params: [{ tag: USERNAME_TO_FETCH, limit: requestLimitToHive }]
                }),
            });
            if (response.ok) {
                hiveData = await response.json();
                if (!hiveData.error) {
                    fetchError = null;
                    break;
                } else {
                    fetchError = new Error(`ASTRO SERVER: Error de la API de Hive en ${nodeUrl}: ${JSON.stringify(hiveData.error)}`);
                    console.error(fetchError.message);
                }
            } else {
                fetchError = new Error(`ASTRO SERVER: Error HTTP de la API de Hive en ${nodeUrl}: ${response.status} - ${await response.text()}`);
                console.error(fetchError.message);
            }
        } catch (error) {
            fetchError = new Error(`ASTRO SERVER: Error de red al conectar con ${nodeUrl}: ${error.message}`);
            console.error(error);
        }
    }

    if (hiveData && !hiveData.error && hiveData.result) {
        const allFetchedItems = hiveData.result || [];

        const originalPosts = allFetchedItems.filter(post =>
            post.author === USERNAME_TO_FETCH &&
            (!post.reblogged_by || post.reblogged_by.length === 0)
        );

        initialPosts = originalPosts.slice(0, POSTS_PER_PAGE);

        if (allFetchedItems.length < requestLimitToHive || allFetchedItems.length === 0) {
            initialPostsHasMore = false;
        } else {
            const lastItemOriginal = allFetchedItems[allFetchedItems.length - 1];
            initialPostsNextStartAuthor = lastItemOriginal.author;
            initialPostsNextStartPermlink = lastItemOriginal.permlink;
            initialPostsHasMore = true;
        }

        console.log("ASTRO SERVER: Posts originales iniciales cargados:", initialPosts.length, "HasMore:", initialPostsHasMore, "Next:", initialPostsNextStartPermlink);

    } else {
        console.error("ASTRO SERVER: No se pudieron cargar los posts originales iniciales desde Hive.", fetchError);
        initialPostsHasMore = false;
    }
} catch (error) {
    console.error("ASTRO SERVER: Error general al procesar posts iniciales:", error);
    initialPostsHasMore = false;
}

let initialReblogs = [];
let initialReblogsNextStartAuthor = '';
let initialReblogsNextStartPermlink = '';
let initialReblogsHasMore = true;
---
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Blog de Hive de @{USERNAME_TO_FETCH}</title>
    <link rel="stylesheet" href="/styles/global.css">
    <style>
        .tabs {
            display: flex;
            margin-bottom: 20px;
            border-bottom: 2px solid #ccc;
        }
        .tab-button {
            padding: 10px 15px;
            cursor: pointer;
            border: none;
            background-color: transparent;
            font-size: 1em;
            color: #555;
            transition: all 0.3s ease;
        }
        .tab-button.active {
            border-bottom: 2px solid #007bff;
            color: #007bff;
            font-weight: bold;
        }
        .tab-content {
            display: none;
        }
        .tab-content.active {
            display: block;
        }
        .load-more-container {
            text-align: center;
            margin-top: 30px;
        }
        .load-more-button {
            padding: 10px 20px;
            font-size: 1.1em;
            cursor: pointer;
            background-color: #007bff;
            color: white;
            border: none;
            border-radius: 5px;
            transition: background-color 0.3s ease;
        }
        .load-more-button:hover {
            background-color: #0056b3;
        }
        .no-more-posts-message {
            text-align: center;
            margin-top: 20px;
            color: #777;
        }
        .debug-post-card {
            border: 1px solid #ddd;
            padding: 15px;
            margin-bottom: 10px;
            background-color: #f9f9f9;
            border-radius: 8px;
        }
        .debug-post-card h3 {
            margin-top: 0;
            margin-bottom: 5px;
            color: #333;
        }
        .debug-post-card pre {
            background-color: #eee;
            padding: 10px;
            border-radius: 5px;
            overflow-x: auto;
            white-space: pre-wrap; /* Permite que el texto se ajuste */
            word-wrap: break-word; /* Rompe palabras largas */
            font-size: 0.85em;
        }
    </style>
</head>
<body>
    <button id="theme-toggle">Activar Modo Oscuro</button>
    <h1>Posts de Hive de @{USERNAME_TO_FETCH}</h1>

    <div class="tabs">
        <button class="tab-button active" data-tab="posts">Posts Originales</button>
        <button class="tab-button" data-tab="reblogs">Reblogs (DEBUG)</button>
    </div>

    <div id="posts-tab-content" class="tab-content active"
        data-content-type="posts"
        data-username={USERNAME_TO_FETCH}
        data-posts-per-page={POSTS_PER_PAGE}
        data-next-start-author={initialPostsNextStartAuthor}
        data-next-start-permlink={initialPostsNextStartPermlink}
        data-has-more-posts={initialPostsHasMore}
    >
        <div class="post-list">
            {initialPosts.length === 0 ? (
                <p>No se encontraron posts originales o hubo un error al cargar.</p>
            ) : (
                initialPosts.map(post => (
                    <PostCard post={post} />
                ))
            )}
        </div>
        <div class="load-more-container">
            {initialPostsHasMore && (
                <button class="load-more-button">Cargar más posts</button>
            )}
            <p class="no-more-posts-message" style="display: {initialPostsHasMore ? 'none' : 'block'};">No hay más posts para cargar.</p>
        </div>
    </div>

    <div id="reblogs-tab-content" class="tab-content"
        data-content-type="reblogs_debug" {/* CAMBIADO para que la función de Netlify sepa que es debug */}
        data-username={USERNAME_TO_FETCH}
        data-posts-per-page={POSTS_PER_PAGE}
        data-next-start-author={initialReblogsNextStartAuthor}
        data-next-start-permlink={initialReblogsNextStartPermlink}
        data-has-more-posts={initialReblogsHasMore}
    >
        <div class="post-list">
            <p>Haz clic en "Cargar más reblogs (DEBUG)" para ver los posts brutos de Hive.</p>
        </div>
        <div class="load-more-container">
            <button class="load-more-button">Cargar más reblogs (DEBUG)</button>
            <p class="no-more-posts-message" style="display: none;">No hay más reblogs para cargar.</p>
        </div>
    </div>

    <script src="../scripts/theme.js"></script>
    <script>
        document.addEventListener('DOMContentLoaded', () => {
            const FUNCTIONS_BASE_URL = 'https://dreamy-baklava-d17cb6.netlify.app/.netlify/functions';
            const USERNAME_TO_FETCH = 'quigua';

            const tabButtons = document.querySelectorAll('.tab-button');
            const tabContents = document.querySelectorAll('.tab-content');

            const paginationState = {
                posts: {
                    nextStartAuthor: document.getElementById('posts-tab-content').dataset.nextStartAuthor || '',
                    nextStartPermlink: document.getElementById('posts-tab-content').dataset.nextPermlink || '',
                    hasMorePosts: document.getElementById('posts-tab-content').dataset.hasMorePosts === 'true',
                    postListDiv: document.getElementById('posts-tab-content').querySelector('.post-list'),
                    loadMoreButton: document.getElementById('posts-tab-content').querySelector('.load-more-button'),
                    noMoreMessage: document.getElementById('posts-tab-content').querySelector('.no-more-posts-message')
                },
                reblogs: { // Se mantiene 'reblogs' como clave interna, pero el contentType será 'reblogs_debug'
                    nextStartAuthor: document.getElementById('reblogs-tab-content').dataset.nextStartAuthor || '',
                    nextStartPermlink: document.getElementById('reblogs-tab-content').dataset.nextPermlink || '',
                    hasMorePosts: document.getElementById('reblogs-tab-content').dataset.hasMorePosts === 'true',
                    postListDiv: document.getElementById('reblogs-tab-content').querySelector('.post-list'),
                    loadMoreButton: document.getElementById('reblogs-tab-content').querySelector('.load-more-button'),
                    noMoreMessage: document.getElementById('reblogs-tab-content').querySelector('.no-more-posts-message')
                }
            };

            const updateLoadMoreVisibility = (tabKey) => {
                const state = paginationState[tabKey];
                if (state.loadMoreButton) {
                    state.loadMoreButton.style.display = state.hasMorePosts ? 'block' : 'none';
                }
                if (state.noMoreMessage) {
                    state.noMoreMessage.style.display = state.hasMorePosts ? 'none' : 'block';
                }
            };

            updateLoadMoreVisibility('posts');
            paginationState.reblogs.noMoreMessage.style.display = 'none';

            // FUNCIÓN DE RENDERIZADO MODIFICADA PARA DEBUG
            const renderPosts = (posts, targetPostListDiv, debugMode = false) => {
                posts.forEach(post => {
                    const postCard = document.createElement('div');
                    postCard.className = debugMode ? 'debug-post-card' : 'post-card';
                    
                    if (debugMode) {
                        // En modo debug, mostramos el JSON completo del post
                        postCard.innerHTML = `
                            <h3>Post Title: ${post.title || 'N/A'}</h3>
                            <p>Author: ${post.author || 'N/A'}</p>
                            <p>Permlink: ${post.permlink || 'N/A'}</p>
                            <p>Created: ${new Date(post.created).toLocaleDateString()}</p>
                            <p>Reblogged By: ${post.reblogged_by ? JSON.stringify(post.reblogged_by) : '[]'}</p>
                            <pre>${JSON.stringify(post, null, 2)}</pre>
                        `;
                    } else {
                        // Modo normal para posts originales (si se usa)
                        const displayAuthor = post.reblogged_by && post.reblogged_by.length > 0 && post.author !== USERNAME_TO_FETCH
                            ? `${USERNAME_TO_FETCH} (reblog de ${post.author})`
                            : post.author;

                        postCard.innerHTML = `
                            <h3><a href="https://hive.blog/@${post.author}/${post.permlink}" target="_blank" rel="noopener noreferrer">${post.title}</a></h3>
                            <p>Por ${displayAuthor} el ${new Date(post.created).toLocaleDateString()}</p>
                            <p>${post.body.substring(0, 150)}...</p>
                        `;
                    }
                    targetPostListDiv.appendChild(postCard);
                });
            };

            const loadPostsForTab = async (tabKey) => {
                const state = paginationState[tabKey];
                const contentType = document.getElementById(`${tabKey}-tab-content`).dataset.contentType;
                const username = document.getElementById(`${tabKey}-tab-content`).dataset.username;
                const postsPerPage = parseInt(document.getElementById(`${tabKey}-tab-content`).dataset.postsPerPage);

                if (!state.hasMorePosts) {
                    console.log(`No hay más ${tabKey} para cargar.`);
                    return;
                }

                state.loadMoreButton.textContent = 'Cargando...';
                state.loadMoreButton.disabled = true;

                try {
                    const url = new URL(`${FUNCTIONS_BASE_URL}/get-user-posts`);
                    url.searchParams.append('username', username);
                    // Para la versión DEBUG, no necesitamos enviar 'limit' o 'contentType' específico
                    // ya que la función ignorará 'contentType' y siempre devolverá 20 posts brutos.
                    // Sin embargo, si quieres que el front sepa cuántos esperaba, se podría mantener.
                    // Para este modo de debug, es irrelevante lo que pida el 'limit' del front.
                    url.searchParams.append('limit', postsPerPage); 
                    // No enviar contentType si estamos en debug para reblogs, la función lo ignora.
                    if (contentType && contentType !== 'reblogs_debug') {
                         url.searchParams.append('contentType', contentType);
                    }

                    if (state.nextStartAuthor && state.nextStartPermlink) {
                        url.searchParams.append('start_author', state.nextStartAuthor);
                        url.searchParams.append('start_permlink', state.nextStartPermlink);
                    }

                    const response = await fetch(url.toString());
                    const responseData = await response.json();

                    if (responseData.error) {
                        console.error('Error al cargar posts:', responseData.error);
                        state.postListDiv.innerHTML = `<p class="text-red-500 text-center">Error al cargar ${tabKey}: ${responseData.error.message || responseData.error}</p>`;
                        state.hasMorePosts = false;
                    } else {
                        const newPosts = responseData.posts || [];
                        console.log(`Cargados ${newPosts.length} posts brutos para ${tabKey} (DEBUG).`);
                        console.log('Datos brutos recibidos:', responseData); // MUY IMPORTANTE PARA DEBUG

                        if (state.postListDiv.children.length === 1 && state.postListDiv.children[0].tagName === 'P' && state.postListDiv.children[0].textContent.includes('Haz clic en')) {
                            state.postListDiv.innerHTML = '';
                        }
                        // Renderiza en modo debug para la pestaña 'reblogs'
                        renderPosts(newPosts, state.postListDiv, tabKey === 'reblogs');

                        state.nextStartAuthor = responseData.nextStartAuthor || '';
                        state.nextStartPermlink = responseData.nextStartPermlink || '';
                        state.hasMorePosts = responseData.hasMore;
                    }
                } catch (error) {
                    console.error('Error de red al cargar posts:', error);
                    state.postListDiv.innerHTML = `<p class="text-red-500 text-center">Error de red al cargar ${tabKey}. Inténtelo de nuevo.</p>`;
                    state.hasMorePosts = false;
                } finally {
                    state.loadMoreButton.textContent = `Cargar más ${tabKey}`;
                    state.loadMoreButton.disabled = false;
                    updateLoadMoreVisibility(tabKey);
                }
            };

            tabButtons.forEach(button => {
                button.addEventListener('click', () => {
                    const targetTab = button.dataset.tab;

                    tabButtons.forEach(btn => btn.classList.remove('active'));
                    tabContents.forEach(content => content.classList.remove('active'));

                    button.classList.add('active');
                    document.getElementById(`${targetTab}-tab-content`).classList.add('active');

                    // Carga inicial para la pestaña de reblogs solo si es la primera vez que se activa
                    if (targetTab === 'reblogs' && 
                        paginationState.reblogs.postListDiv.children.length === 1 && 
                        paginationState.reblogs.postListDiv.children[0].tagName === 'P' &&
                        paginationState.reblogs.postListDiv.children[0].textContent.includes('Haz clic en')) {
                         loadPostsForTab('reblogs');
                    }
                });
            });

            paginationState.posts.loadMoreButton.addEventListener('click', () => loadPostsForTab('posts'));
            paginationState.reblogs.loadMoreButton.addEventListener('click', () => loadPostsForTab('reblogs'));
        });
    </script>
</body>
</html>