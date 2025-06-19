// src/scripts/pagination.js
document.addEventListener('DOMContentLoaded', () => {
    const FUNCTIONS_BASE_URL = 'https://dreamy-baklava-d17cb6.netlify.app/.netlify/functions';
    const tabsContainer = document.querySelector('.tabs');
    const tabButtons = document.querySelectorAll('.tab-button');
    const tabContents = document.querySelectorAll('.tab-content');

    // Estado global de la paginación para cada tipo de contenido
    const paginationState = {
        posts: {
            nextStartAuthor: '',
            nextStartPermlink: '',
            hasMorePosts: true,
            currentPage: 0 // Para llevar la cuenta de las "páginas" cargadas
        },
        reblogs: {
            nextStartAuthor: '',
            nextStartPermlink: '',
            hasMorePosts: true,
            currentPage: 0
        }
    };

    // Inicializar el estado de los posts originales desde el HTML renderizado por Astro
    const initialPostsTab = document.getElementById('posts-tab-content');
    paginationState.posts.nextStartAuthor = initialPostsTab.dataset.nextStartAuthor || '';
    paginationState.posts.nextStartPermlink = initialPostsTab.dataset.nextStartPermlink || '';
    paginationState.posts.hasMorePosts = initialPostsTab.dataset.hasMorePosts === 'true';
    if (initialPostsTab.dataset.hasMorePosts === 'false') {
        initialPostsTab.querySelector('.load-more-button').style.display = 'none';
        initialPostsTab.querySelector('.no-more-posts-message').style.display = 'block';
    }


    // Función para renderizar posts
    const renderPosts = (posts, containerElement) => {
        const postListDiv = containerElement.querySelector('.post-list');
        postListDiv.innerHTML = ''; // Limpia el contenido actual
        if (posts.length === 0) {
            postListDiv.innerHTML = '<p>No se encontraron más posts.</p>';
            return;
        }
        posts.forEach(post => {
            const postCard = document.createElement('div');
            postCard.className = 'post-card'; // Asume una clase para tu PostCard
            postCard.innerHTML = `
                <h3><a href="/post-detail/?author=${post.author}&permlink=${post.permlink}">${post.title}</a></h3>
                <p>Por ${post.author} el ${new Date(post.created).toLocaleDateString()}</p>
                <p>${post.body.substring(0, 150)}...</p>
            `;
            postListDiv.appendChild(postCard);
        });
    };


    // Manejador de eventos para cargar más posts/reblogs
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
            url.searchParams.append('limit', postsPerPage); // Pide solo 10 a la vez
            url.searchParams.append('contentType', contentType);

            if (currentState.nextStartAuthor && currentState.nextStartPermlink) {
                url.searchParams.append('start_author', currentState.nextStartAuthor);
                url.searchParams.append('start_permlink', currentState.nextStartPermlink);
            }

            const response = await fetch(url.toString());
            const data = await response.json();

            if (data.error) {
                console.error(`Error al cargar ${contentType}:`, data.error);
                alert(`Error al cargar ${contentType}: ${data.error}`);
                currentState.hasMorePosts = false;
            } else {
                const newPosts = data.posts || [];
                console.log(`Cargados ${newPosts.length} nuevos ${contentType}.`);

                renderPosts(newPosts, currentTabContent); // Renderiza SOLO los nuevos posts

                if (newPosts.length < postsPerPage) {
                    currentState.hasMorePosts = false;
                } else {
                    const lastPost = newPosts[newPosts.length - 1];
                    currentState.nextStartAuthor = lastPost.author;
                    currentState.nextStartPermlink = lastPost.permlink;
                }
                currentState.currentPage++;
            }
        } catch (error) {
            console.error(`Error de red al cargar ${contentType}:`, error);
            alert(`Error de red al cargar ${contentType}. Inténtelo de nuevo.`);
            currentState.hasMorePosts = false;
        } finally {
            event.target.textContent = `Cargar más ${contentType === 'posts' ? 'posts' : 'reblogs'}`;
            event.target.disabled = false;
            
            // Actualiza el estado del botón y mensaje
            if (!currentState.hasMorePosts) {
                event.target.style.display = 'none';
                currentTabContent.querySelector('.no-more-posts-message').style.display = 'block';
            }
        }
    };

    // Adjuntar manejadores de eventos a todos los botones "Cargar más"
    document.querySelectorAll('.load-more-button').forEach(button => {
        button.addEventListener('click', loadMoreHandler);
    });

    // Manejador de eventos para las pestañas
    const activateTab = async (tabName) => {
        tabButtons.forEach(button => {
            if (button.dataset.tab === tabName) {
                button.classList.add('active');
            } else {
                button.classList.remove('active');
            }
        });

        tabContents.forEach(content => {
            if (content.id === `${tabName}-tab-content`) {
                content.classList.add('active');
            } else {
                content.classList.remove('active');
            }
        });

        const currentTabContent = document.getElementById(`${tabName}-tab-content`);
        const currentState = paginationState[tabName];
        
        // Si es la primera vez que se carga esta pestaña (y no es la de posts iniciales)
        if (tabName === 'reblogs' && currentState.currentPage === 0) {
            const postListDiv = currentTabContent.querySelector('.post-list');
            postListDiv.innerHTML = '<p>Cargando reblogs...</p>'; // Muestra un mensaje de carga
            // Simular un clic en el botón de carga para iniciar la carga de reblogs
            await loadMoreHandler({ target: currentTabContent.querySelector('.load-more-button') });
        }
    };

    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            activateTab(button.dataset.tab);
        });
    });

    // Inicializar la pestaña activa (Posts Originales por defecto)
    activateTab('posts'); 
});