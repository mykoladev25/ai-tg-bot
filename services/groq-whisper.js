const Groq = require('groq-sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});


async function transcribeVoice(audioUrl) {
    try {
        const audioResponse = await axios.get(audioUrl, {
            responseType: 'arraybuffer'
        });

        const tempDir = '/tmp';
        const tempFile = path.join(tempDir, `audio_${Date.now()}.ogg`);
        fs.writeFileSync(tempFile, Buffer.from(audioResponse.data));

        //  
        const transcription = await groq.audio.transcriptions.create({
            file: fs.createReadStream(tempFile),
            model: 'whisper-large-v3',
            response_format: 'json'
        });

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