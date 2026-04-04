const axios = require('axios');
const FormData = require('form-data');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;


async function transcribeVoice(audioUrl) {
    try {
        const audioResponse = await axios.get(audioUrl, {
            responseType: 'arraybuffer'
        });

        const audioBuffer = Buffer.from(audioResponse.data);

        const result = await transcribeWithReplicate(audioBuffer);

        return {
            success: true,
            text: result.text
        };

    } catch (error) {
        console.error('Whisper API Error:', error);
        return {
            success: false,
            error: error.message
        };
    }
}


async function transcribeWithReplicate(audioBuffer) {
    const axios = require('axios');
    const REPLICATE_API_KEY = process.env.REPLICATE_API_KEY;

    const base64Audio = audioBuffer.toString('base64');
    const dataUri = `data:audio/ogg;base64,${base64Audio}`;

    const response = await axios.post(
        'https://api.replicate.com/v1/predictions',
        {
            version: 'openai/whisper:4d50797290df275329f202e48c76360b3f22b08d28c196cbc54600319435f8d2',
            input: {
                audio: dataUri,
                model: 'large-v3',
                translate: false
            }
        },
        {
            headers: {
                'Authorization': `Token ${REPLICATE_API_KEY}`,
                'Content-Type': 'application/json'
            }
        }
    );

    const predictionId = response.data.id;

    let result = null;
    let attempts = 0;

    while (!result && attempts < 30) {
        await new Promise(resolve => setTimeout(resolve, 2000));

        const statusResponse = await axios.get(
            `https://api.replicate.com/v1/predictions/${predictionId}`,
            {
                headers: {
                    'Authorization': `Token ${REPLICATE_API_KEY}`
                }
            }
        );

        if (statusResponse.data.status === 'succeeded') {
            result = statusResponse.data.output;
            break;
        } else if (statusResponse.data.status === 'failed') {
            throw new Error('Transcription failed');
        }

        attempts++;
    }

    return {
        text: result.transcription || result.text || result
    };
}

module.exports = {
    transcribeVoice
};