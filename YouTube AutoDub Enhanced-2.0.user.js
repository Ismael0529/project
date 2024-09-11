// ==UserScript==
// @name         YouTube AutoDub Enhanced
// @version      2.0
// @description  Automatic dubbing for YouTube videos with improved UI, synchronization, and speed control
// @match        https://www.youtube.com/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @require      https://cdnjs.cloudflare.com/ajax/libs/bootstrap/5.1.3/js/bootstrap.min.js
// ==/UserScript==

(function() {
    'use strict';

    GM_addStyle(`
        @import url('https://cdnjs.cloudflare.com/ajax/libs/bootstrap/5.1.3/css/bootstrap.min.css');

        #auto-dub-floating-btn {
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 9999;
            width: 50px;
            height: 50px;
            font-size: 24px;
            border-radius: 50%;
            box-shadow: 0 2px 5px rgba(0,0,0,0.3);
        }

        #auto-dub-popup {
            display: none;
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            z-index: 10000;
            max-width: 400px;
            width: 100%;
        }

        #auto-dub-subtitles {
            position: absolute;
            bottom: 60px;
            left: 50%;
            transform: translateX(-50%);
            color: white;
            text-shadow: 1px 1px 1px black;
            font-size: 24px;
            text-align: center;
            z-index: 1000;
            padding: 5px 10px;
            background-color: rgba(0, 0, 0, 0.7);
            border-radius: 5px;
        }
    `);

    class EnhancedAutoDubbing {
        constructor() {
            this.captionData = [];
            this.isActive = false;
            this.currentVoice = null;
            this.audioContext = null;
            this.gainNode = null;
            this.video = null;
            this.speechQueue = [];
            this.lastSpeechEndTime = 0;
            this.subtitlesEnabled = false;
            this.subtitleContainer = null;
            this.originalPlaybackRate = 1;

            this.initializeAudioContext();
            this.createUI();
            this.setupVoices();
            this.addEventListeners();
            this.setupMutationObserver();
        }

        initializeAudioContext() {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.gainNode = this.audioContext.createGain();
            this.gainNode.connect(this.audioContext.destination);
        }

        async setupVoices() {
            if (speechSynthesis.getVoices().length === 0) {
                await new Promise(resolve => speechSynthesis.onvoiceschanged = resolve);
            }
            this.populateVoiceList();
            this.loadLastUsedVoice();
            this.loadSettings();
        }

        async fetchCaptionData(locale) {
            try {
                const videoId = this.getVideoId();
                const url = await this.fetchCaptionDataUrl(locale);
                if (!url) {
                    throw new Error("Caption URL not found");
                }

                const response = await fetch(url);
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                const json = await response.json();
                this.processCaptions(json.events);
            } catch (error) {
                console.error("Error fetching caption data:", error);
            }
        }

        processCaptions(events) {
            this.captionData = events.reduce((acc, event) => {
                if (event.segs && Array.isArray(event.segs)) {
                    const segment = event.segs.reduce((text, seg) => text + (seg.utf8 || ''), '').trim();
                    if (segment) {
                        acc.push({
                            tStartMs: event.tStartMs,
                            tEndMs: event.tStartMs + (event.dDurationMs || 0),
                            segment
                        });
                    }
                }
                return acc;
            }, []);
        }

        handleTimeUpdate() {
            if (!this.isActive) return;

            const currentTime = this.video.currentTime * 1000;

            if (this.subtitlesEnabled) {
                this.updateSubtitles(currentTime);
            }

            while (this.speechQueue.length > 0 && this.speechQueue[0].startTime <= currentTime) {
                const nextSpeech = this.speechQueue.shift();
                this.speakCaption(nextSpeech.caption);
            }

            if (this.speechQueue.length === 0) {
                const nextCaption = this.getNextCaption(currentTime);
                if (nextCaption) {
                    this.speechQueue.push({ caption: nextCaption, startTime: nextCaption.tStartMs });
                }
            }
        }

        updateSubtitles(currentTime) {
            const currentCaption = this.captionData.find(caption =>
                caption.tStartMs <= currentTime && caption.tEndMs > currentTime
            );
            if (currentCaption) {
                this.subtitleContainer.textContent = currentCaption.segment;
            } else {
                this.subtitleContainer.textContent = '';
            }
        }

        getNextCaption(currentTime) {
            return this.captionData.find(caption => caption.tStartMs > currentTime);
        }

        speakCaption(caption) {
            const utterance = new SpeechSynthesisUtterance(caption.segment);
            utterance.voice = this.currentVoice;
            utterance.volume = parseFloat(this.volumeControl.value);
            utterance.rate = parseFloat(this.speedControl.value);
            utterance.pitch = parseFloat(this.pitchControl.value);

            speechSynthesis.speak(utterance);
        }

        startDubbing() {
            this.video = document.querySelector('video');
            if (!this.video) return;

            this.isActive = true;
            this.originalPlaybackRate = this.video.playbackRate;
            this.video.playbackRate = 0.8;
            this.video.addEventListener('timeupdate', this.handleTimeUpdate.bind(this));
        }

        stopDubbing() {
            if (!this.video) return;

            this.isActive = false;
            this.video.playbackRate = this.originalPlaybackRate;
            speechSynthesis.cancel();
            this.video.removeEventListener('timeupdate', this.handleTimeUpdate.bind(this));
            this.speechQueue = [];
        }

        async fetchCaptionDataUrl(locale) {
            try {
                const playerResponse = await this.fetchYoutubePlayerData();
                if (!playerResponse) {
                    return undefined;
                }
                const captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

                const manualCaptions = captionTracks?.filter(track => track.kind !== "asr");
                const autoCaptions = captionTracks?.filter(track => track.kind === "asr");

                const prioritizedTracks = [...(manualCaptions || []), ...(autoCaptions || [])];

                const playLocales = [locale, ...this.getAlternativeLanguages(locale)];

                for (const playLocale of playLocales) {
                    const localeCaptionBaseUrl = prioritizedTracks?.find(track => track.languageCode === playLocale)?.baseUrl;
                    if (localeCaptionBaseUrl) return `${localeCaptionBaseUrl}&fmt=json3`;
                }

                if (!prioritizedTracks?.length) {
                    console.log("No captions found", playerResponse);
                    return undefined;
                }

                const baseUrl = prioritizedTracks[0]?.baseUrl;
                if (!baseUrl) {
                    console.log("Could not get base URL", playerResponse);
                    return undefined;
                }

                return `${baseUrl.replace(/,/g, "%2C")}&fmt=json3&xorb=2&xobt=3&xovt=3&tlang=${locale}`;
            } catch (err) {
                console.log("fetchCaptionDataUrl got error", err);
                return undefined;
            }
        }

        async fetchYoutubePlayerData() {
            try {
                const ytCfgScript = document.evaluate("//script[@nonce and contains(text(),'INNERTUBE_API_KEY')]", document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotItem(0);
                if (!ytCfgScript) {
                    console.log("ERROR: ytcfg.set({\"CLIENT_CANARY_STATE... not found");
                    return undefined;
                }
                const ytCfgJSON = ytCfgScript.innerText.replace(/^[\s\S]*ytcfg\.set\({/g, '{').replace(/}\);\s*window\.ytcfg\.obfuscatedData_[\s\S]*/, '}');
                const ytConfig = JSON.parse(ytCfgJSON);
                const key = ytConfig?.INNERTUBE_API_KEY;
                const payload = JSON.stringify({
                    context: ytConfig?.INNERTUBE_CONTEXT,
                    videoId: this.getVideoId()
                });
                const targetUrl = `https://www.youtube.com/youtubei/v1/player?key=${key}&prettyPrint=false`;
                const res = await fetch(targetUrl, {
                    method: "POST",
                    body: payload,
                    headers: {
                        "content-type": "application/json"
                    }
                });
                return await res.json();
            } catch (err) {
                console.log("fetchYoutubePlayerData got error", err);
                return undefined;
            }
        }

        getVideoId() {
            const videoIDMatched = window?.location?.href?.match(/\/watch\?v=([^&]*)/);
            if (videoIDMatched && videoIDMatched.length > 0) return videoIDMatched[1];
            const embedIDMatched = window?.location?.href?.match(/\/embed\/([^?]*)/);
            if (embedIDMatched && embedIDMatched.length > 0) return embedIDMatched[1];
            return undefined;
        }

        getAlternativeLanguages(baseLang) {
            const alternatives = {
                pt: ['pt-BR', 'pt-PT'],
                en: ['en-US', 'en-GB', 'en-AU', 'en-CA'],
                es: ['es-ES', 'es-MX', 'es-US'],
                fr: ['fr-FR', 'fr-CA'],
            };
            return alternatives[baseLang] || [];
        }

        createUI() {
            this.createFloatingButton();
            this.createPopup();
        }

        createFloatingButton() {
            const button = document.createElement('button');
            button.id = 'auto-dub-floating-btn';
            button.className = 'btn btn-primary';
            button.innerHTML = '🎙️';
            button.title = 'AutoDub Settings';
            button.addEventListener('click', () => this.togglePopup());
            document.body.appendChild(button);
        }

        createPopup() {
            const popup = document.createElement('div');
            popup.id = 'auto-dub-popup';
            popup.className = 'card';
            popup.innerHTML = `
                <div class="card-body">
                    <h5 class="card-title">AutoDub Settings</h5>
                    <div class="mb-3">
                        <label for="voice-select" class="form-label">Voice Selection:</label>
                        <select id="voice-select" class="form-select"></select>
                    </div>
                    <div class="mb-3">
                        <label for="volume-control" class="form-label">Volume:</label>
                        <input type="range" class="form-range" id="volume-control" min="0" max="1" step="0.1" value="1">
                    </div>
                    <div class="mb-3">
                        <label for="speed-control" class="form-label">Speed:</label>
                        <input type="range" class="form-range" id="speed-control" min="0.5" max="2" step="0.1" value="1">
                    </div>
                    <div class="mb-3">
                        <label for="pitch-control" class="form-label">Pitch:</label>
                        <input type="range" class="form-range" id="pitch-control" min="0.5" max="2" step="0.1" value="1">
                    </div>
                    <button id="toggle-dub-btn" class="btn btn-primary me-2">Enable AutoDub</button>
                    <button id="toggle-subtitles-btn" class="btn btn-secondary">Enable Subtitles</button>
                </div>
            `;
            document.body.appendChild(popup);

            this.voiceSelect = document.getElementById('voice-select');
            this.volumeControl = document.getElementById('volume-control');
            this.speedControl = document.getElementById('speed-control');
            this.pitchControl = document.getElementById('pitch-control');
            const toggleDubBtn = document.getElementById('toggle-dub-btn');
            const toggleSubtitlesBtn = document.getElementById('toggle-subtitles-btn');

            toggleDubBtn.addEventListener('click', () => this.toggleDubbing());
            toggleSubtitlesBtn.addEventListener('click', () => this.toggleSubtitles());

            this.voiceSelect.addEventListener('change', () => this.updateVoice());
            this.volumeControl.addEventListener('input', () => this.saveSettings());
            this.speedControl.addEventListener('input', () => this.saveSettings());
            this.pitchControl.addEventListener('input', () => this.saveSettings());
        }

        togglePopup() {
            const popup = document.getElementById('auto-dub-popup');
            popup.style.display = popup.style.display === 'none' ? 'block' : 'none';
        }

        toggleDubbing() {
            this.isActive = !this.isActive;
            const toggleDubBtn = document.getElementById('toggle-dub-btn');
            if (this.isActive) {
                toggleDubBtn.textContent = 'Disable AutoDub';
                const locale = this.currentVoice.lang.split('-')[0];
                this.fetchCaptionData(locale).then(() => {
                    this.startDubbing();
                });
            } else {
                toggleDubBtn.textContent = 'Enable AutoDub';
                this.stopDubbing();
            }
        }

        toggleSubtitles() {
            this.subtitlesEnabled = !this.subtitlesEnabled;
            const toggleSubtitlesBtn = document.getElementById('toggle-subtitles-btn');
            if (this.subtitlesEnabled) {
                this.createSubtitleContainer();
                toggleSubtitlesBtn.textContent = 'Disable Subtitles';
            } else {
                this.removeSubtitleContainer();
                toggleSubtitlesBtn.textContent = 'Enable Subtitles';
            }
        }

        createSubtitleContainer() {
            if (!this.subtitleContainer) {
                this.subtitleContainer = document.createElement('div');
                this.subtitleContainer.id = 'auto-dub-subtitles';
                document.querySelector('#movie_player').appendChild(this.subtitleContainer);
            }
        }

        removeSubtitleContainer() {
            if (this.subtitleContainer) {
                this.subtitleContainer.remove();
                this.subtitleContainer = null;
            }
        }

        populateVoiceList() {
            const voices = speechSynthesis.getVoices();
            this.voiceSelect.innerHTML = voices.map((voice, i) =>
                `<option value="${i}">${voice.name} (${voice.lang})</option>`
            ).join('');
        }

        updateVoice() {
            const selectedIndex = this.voiceSelect.value;
            this.currentVoice = speechSynthesis.getVoices()[selectedIndex];
            this.saveLastUsedVoice();
        }

        loadLastUsedVoice() {
            const lastUsedVoiceIndex = GM_getValue('lastUsedVoiceIndex', 0);
            const voices = speechSynthesis.getVoices();
            this.currentVoice = voices[lastUsedVoiceIndex] || voices[0];
            this.voiceSelect.value = lastUsedVoiceIndex;
        }

        saveLastUsedVoice() {
            const voices = speechSynthesis.getVoices();
            const index = voices.findIndex(voice => voice.name === this.currentVoice.name);
            GM_setValue('lastUsedVoiceIndex', index);
        }

        loadSettings() {
            this.volumeControl.value = GM_getValue('volume', 1);
            this.speedControl.value = GM_getValue('speed', 1);
            this.pitchControl.value = GM_getValue('pitch', 1);
        }

        saveSettings() {
            GM_setValue('volume', this.volumeControl.value);
            GM_setValue('speed', this.speedControl.value);
            GM_setValue('pitch', this.pitchControl.value);
        }

        addEventListeners() {
            window.speechSynthesis.onvoiceschanged = this.populateVoiceList.bind(this);
        }

        setupMutationObserver() {
            const videoObserver = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (mutation.type === 'attributes' && mutation.attributeName === 'src') {
                        this.stopDubbing();
                        if (this.isActive) {
                            const locale = this.currentVoice.lang.split('-')[0];
                            this.fetchCaptionData(locale).then(() => {
                                this.startDubbing();
                            });
                        }
                    }
                });
            });

            const observeVideo = () => {
                const video = document.querySelector('video');
                if (video) {
                    videoObserver.observe(video, { attributes: true, attributeFilter: ['src'] });
                } else {
                    setTimeout(observeVideo, 1000);
                }
            };

            observeVideo();
        }
    }

    // Initialize the EnhancedAutoDubbing class when the script runs
    const autoDubbing = new EnhancedAutoDubbing();
})();