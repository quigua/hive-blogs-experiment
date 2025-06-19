// src/scripts/pagination.js
document.addEventListener('DOMContentLoaded', () => {
    // URL base de la función de Netlify. Asegúrate que sea la correcta para tu despliegue.
    const FUNCTIONS_BASE_URL = 'https://dreamy-baklava-d17cb6.netlify.app/.netlify/functions';
    
    const tabsContainer = document.querySelector('.tabs');
    const tabButtons = document.querySelectorAll('.tab-button');
    const tabContents = document.querySelectorAll('.tab-content');

    // Objeto para mantener el estado de paginación de cada tipo de contenido (posts, reblogs)
    const paginationState = {
        posts: {
            nextStartAuthor: '',
            nextStartPermlink: '',
            hasMorePosts: true,
            currentPage: 0 // Para llevar un seguimiento de si ya se ha cargado algo en esta pestaña
        },
        reblogs: {
            nextStartAuthor: '',
            nextStartPermlink: '',
            hasMorePosts: true,
            currentPage: 0
        }
    };

    // Inicializar el estado de los posts originales desde los data-attributes del HTML renderizado por Astro.
    const initialPostsTab = document.getElementById('posts-tab-content');
    paginationState.posts.nextStartAuthor = initialPostsTab.dataset.nextStartAuthor || '';
    paginationState.posts.nextStartPermlink = initialPostsTab.dataset.nextStartPermlink || '';
    // Los data-attributes HTML son strings, convertimos "true"/"false" a booleanos.
    paginationState.posts.hasMorePosts = initialPostsTab.dataset.hasMorePosts === 'true';
    
    // Si Astro ya indicó que no hay más posts iniciales, ocultamos el botón de cargar más.
    if (!paginationState.posts.hasMorePosts) {
        const loadMoreButton = initialPostsTab.querySelector('.load-more-button');
        if (loadMoreButton) loadMoreButton.style.display = 'none';
        const noMoreMessage = initialPostsTab.querySelector('.no-more-posts-message');
        if (noMoreMessage) noMoreMessage.style.display = 'block';
    }

    // Función para renderizar los posts en el contenedor especificado.
    const renderPosts = (posts, containerElement, append = false) => {
        const postListDiv = containerElement.querySelector('.post-list');
        
        // Si no es un "append" (cargar más), limpiamos el contenedor.
        if (!append) {
            postListDiv.innerHTML = ''; 
        }

        if (posts.length === 0) {
            // Si no hay posts nuevos y es la primera carga o no hay más, mostramos un mensaje.
            if (!append || postListDiv.children.length === 0) {
                postListDiv.innerHTML = '<p>No se encontraron más elementos.</p>'; 
            }
            return;
        }

        posts.forEach(post => {
            const postCard = document.createElement('div');
            postCard.className = 'post-card'; 
            postCard.innerHTML = `
                <h3><a href="/post-detail/?author=<span class="math-inline">\{post\.author\}&permlink\=</span>{post.permlink}">${post.title}</a></h3>
                <p>Por ${post.author} el <span class="math-inline">\{new Date\(post\.created\)\.toLocaleDateString\(\)\}</p\>
<p\></span>{post.body.substring(0, 150)}...</p>
            `;
            postListDiv.appendChild(postCard);
        });
    };

    // Handler para el botón "Cargar más".
    const loadMoreHandler = async (event) => {
        const currentTabContent = event.target.closest('.tab-content');
        const contentType = currentTabContent.dataset.contentType;
        const username = currentTabContent.dataset.username;
        const postsPerPage = parseInt(currentTabContent.dataset.postsPerPage);

        const currentState = paginationState[contentType];

        if (!currentState.hasMorePosts) {
            console.log(`No hay más ${contentType} para cargar.`);
            return;
        }

        event.target.textContent = 'Cargando...';
        event.target.disabled = true;

        try {
            const url = new URL(`${FUNCTIONS_BASE_URL}/get-user-posts`);
            url.searchParams.append('username', username);
            url.searchParams.append('limit', postsPerPage); 
            url.searchParams.append('contentType', contentType);

            // Solo enviamos start_author y start_permlink si existen en el estado.
            if (currentState.nextStartAuthor && currentState.nextStartPermlink) {
                url.searchParams.append('start_author', currentState.nextStartAuthor);
                url.searchParams.append('start_permlink', currentState.nextStartPermlink);
            }

            const response = await fetch(url.toString());
            const responseData = await response.json(); // Esperamos un objeto con posts, nextStartAuthor, etc.

            if (responseData.error) {
                console.error(`Error al cargar ${contentType}:`, responseData.error);
                alert(`Error al cargar ${contentType}: ${responseData.error.message || responseData.error}`);
                currentState.hasMorePosts = false;
            } else {
                const newItems = responseData.posts || []; 
                console.log(`Cargados ${newItems.length} nuevos ${contentType}.`);

                // Renderizamos los nuevos posts, añadiéndolos (append = true).
                renderPosts(new