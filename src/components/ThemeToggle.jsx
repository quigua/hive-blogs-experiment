// src/components/ThemeToggle.jsx
import React, { useEffect, useState } from 'react';

function ThemeToggle() {
    const [theme, setTheme] = useState('light'); // Estado interno del tema

    useEffect(() => {
        // 1. Cargar el tema guardado o detectar la preferencia del sistema
        const savedTheme = localStorage.getItem('theme');
        if (savedTheme) {
            setTheme(savedTheme);
            document.body.classList.toggle('dark-mode', savedTheme === 'dark');
        } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
            setTheme('dark');
            document.body.classList.add('dark-mode');
        } else {
            setTheme('light');
            document.body.classList.remove('dark-mode');
        }
    }, []); // Se ejecuta solo una vez al montar el componente

    const toggleTheme = () => {
        const newTheme = theme === 'dark' ? 'light' : 'dark';
        setTheme(newTheme);
        document.body.classList.toggle('dark-mode', newTheme === 'dark');
        localStorage.setItem('theme', newTheme);
    };

    return (
        <button onClick={toggleTheme}>
            {theme === 'dark' ? 'Activar Modo Claro' : 'Activar Modo Oscuro'}
        </button>
    );
}

export default ThemeToggle;