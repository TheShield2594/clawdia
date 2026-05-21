function applyGrayscale(imageData) {
    const { data } = imageData;
    for (let i = 0; i < data.length; i += 4) {
        const g = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        data[i] = data[i + 1] = data[i + 2] = g;
    }
}

function applySepia(imageData) {
    const { data } = imageData;
    for (let i = 0; i < data.length; i += 4) {
        const g     = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        data[i]     = Math.min(255, g * 1.2 + 40);
        data[i + 1] = Math.min(255, g       + 20);
        data[i + 2] = Math.min(255, g * 0.8);
    }
}

module.exports = { applyGrayscale, applySepia };
