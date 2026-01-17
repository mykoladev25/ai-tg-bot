const Groq = require('groq-sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

/**
 * Транскрибувати голос через Groq Whisper
 */
async function transcribeVoice(audioUrl) {
    try {
        // Завантажити аудіо файл
        const audioResponse = await axios.get(audioUrl, {
            responseType: 'arraybuffer'
        });

        // Зберегти тимчасово
        const tempDir = '/tmp';
        const tempFile = path.join(tempDir, `audio_${Date.now()}.ogg`);
        fs.writeFileSync(tempFile, Buffer.from(audioResponse.data));

        //  
        const transcription = await groq.audio.transcriptions.create({
            file: fs.createReadStream(tempFile),
            model: 'whisper-large-v3',
            response_format: 'json'
        });

        // Видалити тимчасовий файл
        fs.unlinkSync(tempFile);

        return {
            success: true,
            text: transcription.text
        };

    } catch (error) {
        console.error('Groq Whisper Error:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

module.exports = {
    transcribeVoice
};