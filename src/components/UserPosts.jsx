// src/components/UserPosts.jsx
import React, { useState, useEffect } from 'react';

function UserPosts({ username = 'quigua' }) { // Por defecto 'quigua'
    const [posts, setPosts] = useState([]);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function fetchUserPosts() {
            try {
                const response = await fetch(`/.netlify/functions/get-user-posts?username=${username}`);
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                const data = await response.json();
                setPosts(data.posts);
            } catch (err) {
                setError(err.message);
            } finally {
                setLoading(false);
            }
        }

        fetchUserPosts();
    }, [username]); // Se ejecuta cuando el componente se monta o cuando 'username' cambia

    if (loading) {
        return <p>Cargando publicaciones de {username}...</p>;
    }

    if (error) {
        return <p style={{ color: 'red' }}>Error al cargar publicaciones: {error}</p>;
    }

    if (posts.length === 0) {
        return <p>No se encontraron publicaciones para {username}.</p>;
    }

    return (
        <div style={{ marginTop: '2rem' }}>
            <h2>Publicaciones de @{username}</h2>
            <div style={{ display: 'grid', gap: '1rem' }}>
                {posts.map(post => (
                    <div key={post.id} style={{ border: '1px solid #eee', padding: '1rem', borderRadius: '8px' }}>
                        <h3><a href={post.url} target="_blank" rel="noopener noreferrer">{post.title}</a></h3>
                        <p><strong>Autor:</strong> @{post.author}</p>
                        <p><strong>Publicado:</strong> {new Date(post.created).toLocaleDateString()}</p>
                        <p>{post.summary}</p>
                    </div>
                ))}
            </div>
        </div>
    );
}

export default UserPosts;