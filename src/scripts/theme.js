// src/scripts/theme.js

document.addEventListener('DOMContentLoaded', () => {
    const themeToggle = document.getElementById('theme-toggle');
    const body = document.body;

    if (!themeToggle) {
        // Si el botón no existe (por ejemplo, en post-detail.astro no lo tenemos), salimos
        return;
    }

    function applyTheme(theme) {
        if (theme === 'dark') {
            body.classList.add('dark-mode');
            themeToggle.textContent = 'Activar Modo Claro';
        } else {
            body.classList.remove('dark-mode');
            themeToggle.textContent = 'Activar Modo Oscuro';
        }
    }

    // 1. Cargar el tema guardado o detectar la preferencia del sistema
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) {
        applyTheme(savedTheme);
    } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
        // Si no hay tema guardado, detecta la preferencia del sistema operativo
        applyTheme('dark');
    } else {
        // Por defecto, aplica el tema claro
        applyTheme('light');
    }

    // 2. Escuchar clics en el botón
    themeToggle.addEventListener('click', () => {
        if (body.classList.contains('dark-mode')) {
            applyTheme('light');
            localStorage.setItem('theme', 'light');
        } else {
            applyTheme('dark');
            localStorage.setItem('theme', 'dark');
        }
    });
});