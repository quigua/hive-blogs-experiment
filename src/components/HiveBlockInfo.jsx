// src/components/HiveBlockInfo.jsx
import React, { useState, useEffect } from 'react';

function HiveBlockInfo() {
    const [blockNumber, setBlockNumber] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function fetchHiveInfo() {
            try {
                const response = await fetch('/.netlify/functions/get-hive-info');
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                const data = await response.json();
                setBlockNumber(data.headBlockNumber);
            } catch (err) {
                setError(err.message);
            } finally {
                setLoading(false);
            }
        }

        fetchHiveInfo();
    }, []); // El array vacío asegura que se ejecute una sola vez al montar el componente

    if (loading) {
        return <p>Cargando información de Hive...</p>;
    }

    if (error) {
        return <p style={{ color: 'red' }}>Error al cargar datos de Hive: {error}</p>;
    }

    return (
        <div>
            <h2>Información de la Blockchain de Hive</h2>
            <p>Número del Último Bloque: <strong>{blockNumber}</strong></p>
        </div>
    );
}

export default HiveBlockInfo;