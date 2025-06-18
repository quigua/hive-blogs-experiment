// src/scripts/pagination.js

document.addEventListener('DOMContentLoaded', () => {
    const loadMoreButton = document.getElementById('load-more-button');
    const postsListContainer = document.getElementById('posts-list');
    const postsGrid = postsListContainer.querySelector('.post-list'); // El contenedor donde se añaden los PostCard
    const noMorePostsMessage = document.getElementById('no-more-posts-message');

    // Salir si no hay botón de carga (por ejemplo, en otras páginas o si no hay posts)
    if (!loadMoreButton || !postsListContainer) {
        return;
    }

    const FUNCTIONS_BASE_URL = 'https://dreamy-baklava-d17cb6.netlify.app/.netlify/functions'; // MISMA URL BASE

    // Función para renderizar un solo PostCard (simulando la lógica de Astro)
    // En una aplicación real, Astro generaría esto en el servidor, pero aquí lo simulamos para añadir al DOM
    function renderPostCard(post) {
        return `
            <div class="post-card">
                <a href="/post-detail?author=${encodeURIComponent(post.author)}&permlink=${encodeURIComponent(post.permlink)}" class="post-title">${post.title}</a>
                <p class="post-meta">Por: @${post.author} - ${new Date(post.created).toLocaleDateString()}</p>
                </div>
        `;
    }

    async function loadMorePosts() {
        // Deshabilitar el botón mientras se carga para evitar clics múltiples
        loadMoreButton.disabled = true;
        loadMoreButton.textContent = 'Cargando...';

        let nextStartAuthor = postsListContainer.dataset.nextStartAuthor;
        let nextStartPermlink = postsListContainer.dataset.nextStartPermlink;
        let username = postsListContainer.dataset.username;
        let postsPerPage = postsListContainer.dataset.postsPerPage; // Esto será un string, Hive espera un número

        // Si ya sabemos que no hay más posts, salimos
        if (postsListContainer.dataset.hasMorePosts === 'false') {
            loadMoreButton.style.display = 'none';
            noMorePostsMessage.style.display = 'block';
            return;
        }

        try {
            const response = await fetch(`${FUNCTIONS_BASE_URL}/get-user-posts?username=${username}&limit=${postsPerPage}&start_author=${nextStartAuthor}&start_permlink=${nextStartPermlink}`);
            if (!response.ok) {
                throw new Error(`Error HTTP: ${response.status}`);
            }
            const data = await response.json();

            if (data.error) {
                console.error("Error al cargar más posts:", data.error, data.details);
                loadMoreButton.textContent = 'Error al cargar';
            } else if (data.posts && Array.isArray(data.posts)) {
                // Añadir los nuevos posts al DOM
                data.posts.forEach(post => {
                    postsGrid.insertAdjacentHTML('beforeend', renderPostCard(post));
                });

                // Actualizar los atributos data-* para la siguiente paginación
                if (data.posts.length < parseInt(postsPerPage)) { // Si se cargaron menos de lo solicitado, no hay más
                    postsListContainer.dataset.hasMorePosts = 'false';
                    loadMoreButton.style.display = 'none';
                    noMorePostsMessage.style.display = 'block';
                } else {
                    const lastNewPost = data.posts[data.posts.length - 1];
                    postsListContainer.dataset.nextStartAuthor = lastNewPost.author;
                    postsListContainer.dataset.nextStartPermlink = lastNewPost.permlink;
                }
                loadMoreButton.textContent = 'Cargar más posts'; // Restablecer texto del botón
            } else {
                // Si la respuesta no tiene posts o es inválida, asumimos que no hay más
                postsListContainer.dataset.hasMorePosts = 'false';
                loadMoreButton.style.display = 'none';
                noMorePostsMessage.style.display = 'block';
            }

        } catch (error) {
            console.error("Error al conectar con la función Netlify para cargar más posts:", error);
            loadMoreButton.textContent = 'Error al cargar';
            // Mostrar un mensaje al usuario si lo deseas
        } finally {
            loadMoreButton.disabled = false; // Habilitar el botón de nuevo
        }
    }

    // Event listener para el botón
    loadMoreButton.addEventListener('click', loadMorePosts);

    // Ocultar el botón si inicialmente no hay más posts
    if (postsListContainer.dataset.hasMorePosts === 'false') {
        loadMoreButton.style.display = 'none';
        noMorePostsMessage.style.display = 'block';
    } else {
        noMorePostsMessage.style.display = 'none'; // Asegúrate de que el mensaje no se muestre inicialmente si hay posts
    }
});