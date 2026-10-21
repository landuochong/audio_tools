import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient

from app import main, voice_profiles, voices


def recording(seconds=4, rate=16000, amplitude=.15):
    samples = amplitude * np.sin(2 * np.pi * 220 * np.arange(int(rate * seconds)) / rate)
    output = io.BytesIO()
    sf.write(output, samples, rate, format='WAV', subtype='PCM_16')
    return output.getvalue()


class VoiceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.patcher = patch.object(voice_profiles, 'VOICE_DIR', Path(self.directory.name))
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.client = TestClient(main.app, base_url='http://127.0.0.1:8030')

    def upload(self, audio=None, **fields):
        return self.client.post('/api/voices', data={
            'name': '测试音色', 'reference_text': '这是参考录音的原文。', **fields},
            files={'file': ('reference.wav', recording() if audio is None else audio, 'audio/wav')})

    def test_profile_round_trip_normalizes_audio_and_deletes_only_selected_profile(self):
        response = self.upload()
        self.assertEqual(response.status_code, 200, response.text)
        profile = response.json()
        other = self.upload(name='另一音色').json()
        self.assertEqual(profile['duration'], 4)
        # Read from disk again: no process-local voice registry required.
        self.assertEqual(voice_profiles.get_profile(profile['id']), profile)
        audio = self.client.get(f"/api/voices/{profile['id']}/audio")
        self.assertEqual(audio.status_code, 200)
        samples, rate = sf.read(io.BytesIO(audio.content))
        self.assertEqual(rate, 24000)
        self.assertEqual(samples.ndim, 1)
        self.assertEqual(len(samples), 96000)
        url, payload = voice_profiles.speech_target('clone:'+profile['id'], 'tts', 'design')
        self.assertEqual((url, payload), ('tts', {'reference_id': profile['id']}))
        ref, text = voice_profiles.reference_for(profile['id'])
        self.assertTrue(ref.is_file())
        self.assertEqual(text, profile['reference_text'])
        self.assertEqual(self.client.delete('/api/voices/'+profile['id']).status_code, 200)
        self.assertEqual(self.client.get(f"/api/voices/{profile['id']}/audio").status_code, 404)
        self.assertEqual(self.client.get('/api/voices').json()['voices'], [other])

    def test_invalid_audio_duration_and_empty_fields_never_create_profiles(self):
        for audio in (b'not audio', b'', recording(2), recording(31), recording(amplitude=0)):
            with self.subTest(size=len(audio)):
                self.assertEqual(self.upload(audio).status_code, 400)
        for fields in ({'name': ' '}, {'reference_text': ' '}):
            self.assertEqual(self.upload(**fields).status_code, 400)
        self.assertEqual(self.client.get('/api/voices').json(), {'voices': []})

    def test_missing_profile_and_path_injection_are_rejected(self):
        for value in ('clone:'+'f'*32, 'clone:../reference', 'clone:/tmp/x'):
            result = self.client.post('/api/synthesize', json={'text': '你好', 'voice': value})
            self.assertIn(result.status_code, (404, 422))
        self.assertEqual(self.client.delete('/api/voices/not-a-profile').status_code, 404)

    def test_foreign_site_cannot_upload_or_delete_references(self):
        headers = {'origin': 'https://example.com'}
        self.assertEqual(self.client.post('/api/voices', headers=headers).status_code, 403)
        self.assertEqual(self.client.delete('/api/voices/'+'a'*32, headers=headers).status_code, 403)

    def test_both_generation_paths_forward_selected_reference(self):
        profile = self.upload().json()
        selected = 'clone:'+profile['id']
        audio = recording()
        calls = []

        def handler(request):
            import json
            calls.append((str(request.url), json.loads(request.content)))
            if request.url.path == '/synthesize':
                return httpx.Response(200, content=audio)
            return httpx.Response(200, text='{"type":"audio","rate":24000,"pcm":"AAAAAA=="}\n{"type":"done"}\n')

        # Capture both HTTP clients without contacting a model or physical device.
        async_client, sync_client = httpx.AsyncClient, httpx.Client
        with patch.object(main.httpx, 'AsyncClient', side_effect=lambda **kw: async_client(transport=httpx.MockTransport(handler))):
            response = self.client.post('/api/synthesize', json={'text': '自定义声音', 'voice': selected})
        self.assertEqual(response.status_code, 200, response.text)
        class Player:
            first_play_at = None
            underflows = device_underflows = buffer_starvations = 0
            def __init__(self, *args): pass
            def append(self, *args): pass
            def finish(self): pass
        with patch.object(main.httpx, 'Client', side_effect=lambda **kw: sync_client(transport=httpx.MockTransport(handler))), \
             patch.object(main, 'list_outputs', return_value=[{'id': 1}]), \
             patch.object(main.sd, 'query_devices', return_value={'default_samplerate': 24000, 'max_output_channels': 1}), \
             patch.object(main.sd, 'check_output_settings'), \
             patch('app.stream_player.StreamPlayer', Player):
            response = self.client.post('/api/stream', json={'text': '自定义声音', 'voice': selected, 'devices': [1]})
        self.assertEqual(response.status_code, 200)
        self.assertIn('"type": "done"', response.text)
        self.assertEqual(len(calls), 2)
        for url, payload in calls:
            self.assertTrue(url.startswith(main.TTS_URL))
            self.assertEqual(payload['reference_id'], profile['id'])
            self.assertEqual(payload['text'], '自定义声音')
        main.clips.clear()


if __name__ == '__main__':
    unittest.main()
