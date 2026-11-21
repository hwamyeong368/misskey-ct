/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { FakePrefer } from './fake-prefer.js';

const lk = vi.hoisted(() => {
	class Emitter {
		private handlers = new Map<string, Set<(...args: any[]) => void>>();
		on(event: string, handler: (...args: any[]) => void) {
			if (!this.handlers.has(event)) this.handlers.set(event, new Set());
			this.handlers.get(event)!.add(handler);
			return this;
		}
		off(event: string, handler: (...args: any[]) => void) {
			this.handlers.get(event)?.delete(handler);
			return this;
		}
		emit(event: string, ...args: any[]) {
			for (const handler of [...this.handlers.get(event) ?? []]) handler(...args);
			return true;
		}
	}

	const RoomEvent = {
		Reconnecting: 'reconnecting',
		Reconnected: 'reconnected',
		Disconnected: 'disconnected',
		ParticipantConnected: 'participantConnected',
		ParticipantDisconnected: 'participantDisconnected',
		TrackPublished: 'trackPublished',
		TrackUnpublished: 'trackUnpublished',
		TrackSubscribed: 'trackSubscribed',
		TrackUnsubscribed: 'trackUnsubscribed',
		TrackMuted: 'trackMuted',
		ActiveDeviceChanged: 'activeDeviceChanged',
		LocalTrackPublished: 'localTrackPublished',
		LocalTrackUnpublished: 'localTrackUnpublished',
		ActiveSpeakersChanged: 'activeSpeakersChanged',
		AudioPlaybackStatusChanged: 'audioPlaybackChanged',
	};
	const TrackEvent = { Restarted: 'restarted', Ended: 'ended' };
	const DisconnectReason = { UNKNOWN_REASON: 0, CLIENT_INITIATED: 1, DUPLICATE_IDENTITY: 2, SERVER_SHUTDOWN: 3, PARTICIPANT_REMOVED: 4, ROOM_DELETED: 5 };
	const Track = {
		Source: { Camera: 'camera', Microphone: 'microphone', ScreenShare: 'screen_share', ScreenShareAudio: 'screen_share_audio', Unknown: 'unknown' },
		Kind: { Audio: 'audio', Video: 'video', Unknown: 'unknown' },
	};
	const preset = (width: number, height: number, maxBitrate: number, fps: number) => ({ width, height, resolution: { width, height, frameRate: fps }, encoding: { maxBitrate, maxFramerate: fps } });
	class VideoPreset {
		width: number;
		height: number;
		encoding: { maxBitrate: number; maxFramerate?: number; priority?: string };
		constructor(width: number, height: number, maxBitrate: number, maxFramerate?: number, priority?: string) {
			this.width = width;
			this.height = height;
			this.encoding = { maxBitrate, maxFramerate, priority };
		}
	}
	const VideoQuality = { LOW: 0, MEDIUM: 1, HIGH: 2 };
	const ScreenSharePresets = {
		h720fps15: preset(1280, 720, 1_500_000, 15),
		h720fps30: preset(1280, 720, 2_000_000, 30),
		h1080fps15: preset(1920, 1080, 2_500_000, 15),
		h1080fps30: preset(1920, 1080, 5_000_000, 30),
	};

	class FakeRemoteParticipant extends Emitter {
		trackPublications = new Map<string, any>();
		setVolume = vi.fn((volume: number, _source?: string) => {
			if (!(volume >= 0 && volume <= 1)) throw new DOMException('The volume is outside the range [0, 1]', 'IndexSizeError');
		});
		constructor(public identity: string) {
			super();
		}
	}

	class FakeRoom extends Emitter {
		static instances: FakeRoom[] = [];
		remoteParticipants = new Map<string, FakeRemoteParticipant>();
		canPlaybackAudio = true;
		localParticipant = {
			identity: 'https://local.test/users/me',
			sid: 'PA_local',
			isScreenShareEnabled: false,
			microphoneTrack: Object.assign(new Emitter(), { kind: 'audio', mediaStreamTrack: { kind: 'audio' } }),
			getTrackPublication: vi.fn((source?: string) => source === Track.Source.Microphone
				? { track: this.localParticipant.microphoneTrack }
				: undefined as any),
			setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
			screenVideo: { source: 'screen_share', mediaStreamTrack: { applyConstraints: vi.fn().mockResolvedValue(undefined), getSettings: vi.fn(() => ({ width: 1280, height: 720, frameRate: 10 })) }, stop: vi.fn() },
			createScreenTracks: vi.fn(async () => [this.localParticipant.screenVideo]),
			publishTrack: vi.fn(async () => { this.localParticipant.isScreenShareEnabled = true; }),
			unpublishTrack: vi.fn().mockResolvedValue(undefined),
			setScreenShareEnabled: vi.fn(async (enabled: boolean) => {
				this.localParticipant.isScreenShareEnabled = enabled;
			}),
		};
		connect = vi.fn().mockResolvedValue(undefined);
		disconnect = vi.fn(async () => {
			this.emit(RoomEvent.Disconnected, DisconnectReason.CLIENT_INITIATED);
		});
		startAudio = vi.fn(async () => {
			this.canPlaybackAudio = true;
		});
		switchActiveDevice = vi.fn(async (kind: string, deviceId: string) => {
			this.emit(RoomEvent.ActiveDeviceChanged, kind, deviceId);
			return true;
		});
		getActiveDevice = vi.fn((_kind: string): string | undefined => undefined);
		constructor(public options: unknown) {
			super();
			FakeRoom.instances.push(this);
		}
	}

	const analyser = { analyser: { fftSize: 512, context: { state: 'running' as AudioContextState }, getFloatTimeDomainData: vi.fn((data: Float32Array) => data.fill(0)) }, cleanup: vi.fn().mockResolvedValue(undefined) };
	const createAudioAnalyser = vi.fn(() => analyser);
	const supportsAudioOutputSelection = vi.fn(() => true);
	return { analyser, createAudioAnalyser, supportsAudioOutputSelection, Emitter, RoomEvent, TrackEvent, DisconnectReason, Track, ScreenSharePresets, VideoPreset, VideoQuality, FakeRoom, FakeRemoteParticipant };
});

vi.mock('livekit-client', async () => ({
	getBrowser: (await vi.importActual<typeof import('livekit-client')>('livekit-client')).getBrowser,
	Room: lk.FakeRoom,
	createAudioAnalyser: lk.createAudioAnalyser,
	supportsAudioOutputSelection: lk.supportsAudioOutputSelection,
	RoomEvent: lk.RoomEvent,
	TrackEvent: lk.TrackEvent,
	DisconnectReason: lk.DisconnectReason,
	Track: lk.Track,
	ScreenSharePresets: lk.ScreenSharePresets,
	VideoPreset: lk.VideoPreset,
	VideoQuality: lk.VideoQuality,
}));

const boostMock = vi.hoisted(() => ({
	instances: [] as any[],
}));
vi.mock('@/utility/voice-boost.js', async importOriginal => {
	const original = await importOriginal<typeof import('@/utility/voice-boost.js')>();
	class FakeVoiceBoost {
		blocked = false;
		set = vi.fn(() => true);
		isReady = vi.fn(() => true);
		prepare = vi.fn();
		release = vi.fn();
		setSinkId = vi.fn().mockResolvedValue(undefined);
		resume = vi.fn(async () => { this.blocked = false; this.options.onBlockedChange?.(false); });
		dispose = vi.fn();
		constructor(public options: { onBlockedChange?: (blocked: boolean) => void; onReadyChange?: () => void }) {
			boostMock.instances.push(this);
		}
	}
	return { ...original, VoiceBoost: FakeVoiceBoost };
});

const mocks = vi.hoisted(() => ({
	misskeyApi: vi.fn(),
	toast: vi.fn(),
	alert: vi.fn(),
	confirm: vi.fn(),
	actions: vi.fn(),
	promiseDialog: vi.fn(promise => promise),
}));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.misskeyApi }));
vi.mock('@/os.js', () => ({ toast: mocks.toast, alert: mocks.alert, confirm: mocks.confirm, actions: mocks.actions, promiseDialog: mocks.promiseDialog }));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer() }));
vi.mock('@/i.js', async importOriginal => ({
	...await importOriginal<typeof import('@/i.js')>(),
	$i: { token: 'test-token', policies: { maxFileSizeMb: 30 } },
}));
vi.mock('@/instance.js', async importOriginal => {
	const original = await importOriginal<typeof import('@/instance.js')>();
	return { ...original, instance: { ...original.instance, maxFileSize: 262_144_000 } };
});

import { prefer as mockedPrefer } from '@/preferences.js';
import { joinVoiceCall, leaveVoiceCall, setParticipantVolume, startRecording, stopRecording, unwatchScreenShare, watchScreenShare } from '@/utility/voice-call.js';

const prefer = mockedPrefer as unknown as FakePrefer;
const room1 = { id: 'r1', name: 'room 1', allowRecording: true } as any;
const lastRoom = () => lk.FakeRoom.instances[lk.FakeRoom.instances.length - 1];

class RecordingStream {
	constructor(private tracks: { kind: string; enabled?: boolean; stop?: () => void }[] = []) {}
	getTracks() { return this.tracks; }
	getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
	getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
}

class RecordingContext {
	static instances: RecordingContext[] = [];
	state = 'running';
	close = vi.fn(async () => { this.state = 'closed'; });
	resume = () => Promise.resolve();
	createMediaStreamDestination = () => ({ stream: new RecordingStream(), channelCount: 2, channelCountMode: 'explicit' });
	createGain = () => ({ connect: vi.fn(), gain: { value: 1 } });
	createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
	constructor() { RecordingContext.instances.push(this); }
}

class Recorder {
	static instances: Recorder[] = [];
	static isTypeSupported = () => true;
	state = 'inactive';
	mimeType: string;
	onstop: (() => void) | null = null;
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	constructor(public stream: { getTracks(): unknown[] }, public options?: MediaRecorderOptions) {
		this.mimeType = options?.mimeType ?? 'audio/webm';
		Recorder.instances.push(this);
	}
	start() { this.state = 'recording'; }
	requestData() { if (this.state === 'inactive') throw new DOMException('inactive', 'InvalidStateError'); }
	stop() {
		if (this.state === 'inactive') throw new DOMException('inactive', 'InvalidStateError');
		this.state = 'inactive';
		queueMicrotask(() => {
			this.ondataavailable?.({ data: new Blob(['last chunk'], { type: this.mimeType }) });
			this.onstop?.();
		});
	}
}

function remoteParticipant(identity: string) {
	const participant = new lk.FakeRemoteParticipant(identity);
	lastRoom().remoteParticipants.set(identity, participant);
	return participant;
}

async function flushRecording() {
	for (let i = 0; i < 40; i++) await Promise.resolve();
}

describe('call recording mix', () => {
	const originalSrcObject = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
	let rawTrack: { kind: string; enabled: boolean; stop: ReturnType<typeof vi.fn<() => void>> };

	beforeEach(() => {
		lk.FakeRoom.instances.length = 0;
		boostMock.instances.length = 0;
		RecordingContext.instances = [];
		Recorder.instances = [];
		delete (HTMLCanvasElement.prototype as unknown as { captureStream?: unknown }).captureStream;
		Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
			configurable: true,
			get(this: { __srcObject?: unknown }) { return this.__srcObject ?? null; },
			set(this: { __srcObject?: unknown }, value: unknown) { this.__srcObject = value; },
		});
		rawTrack = { kind: 'audio', enabled: true, stop: vi.fn() };
		const getUserMedia = vi.fn().mockResolvedValue(new RecordingStream([rawTrack]));
		vi.stubGlobal('MediaStream', RecordingStream);
		vi.stubGlobal('MediaRecorder', Recorder);
		vi.stubGlobal('AudioContext', RecordingContext);
		Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
		vi.spyOn(window, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ id: 'recording-file', url: 'https://local.test/files/recording-file' }) } as Response);
		mocks.misskeyApi.mockReset().mockImplementation(async (endpoint, params) => {
			if (endpoint === 'chat/rooms/voice/join') return { url: 'https://local.test/livekit', token: 't' };
			if (endpoint === 'chat/rooms/voice/recording-folder') return { id: 'recording-folder', name: params.name };
			if (endpoint === 'chat/rooms/voice/recording-result') return null;
			if (endpoint === 'chat/rooms/voice/convert-recording') return { file: { id: 'converted-file', folderId: 'recording-folder' }, download: null };
			return {};
		});
		mocks.toast.mockReset();
		mocks.alert.mockReset();
		mocks.confirm.mockReset().mockResolvedValue({ canceled: false });
		mocks.actions.mockReset().mockResolvedValue({ canceled: false, result: 'retry' });
		prefer.reset({
			'voiceCall.inputDeviceId': null,
			'voiceCall.outputDeviceId': null,
			'voiceCall.echoCancellation': true,
			'voiceCall.noiseSuppression': true,
			'voiceCall.autoGainControl': true,
			'voiceCall.micEnabled': true,
			'voiceCall.participantVolumes': {},
			'voiceCall.screenShareVolumes': {},
			'voiceCall.screenShareVolumesMigrated': false,
			'voiceCall.screenShareQuality': 'sharp',
			'voiceCall.screenShareAudio': true,
		});
	});

	afterEach(async () => {
		await leaveVoiceCall();
		await flushRecording();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		if (originalSrcObject != null) Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', originalSrcObject);
		else delete (HTMLMediaElement.prototype as unknown as { srcObject?: unknown }).srcObject;
	});

	test('feeds the recording mix with the original track while the volume is above 100%', async () => {
		await joinVoiceCall(room1);
		await flushRecording();
		await startRecording();
		const a = remoteParticipant('a');
		const mediaStreamTrack = { kind: 'audio' };
		const element = document.createElement('audio');
		const track = { kind: lk.Track.Kind.Audio, mediaStreamTrack, attach: vi.fn(() => element), detach: vi.fn(() => [element]) };
		const publication = { source: lk.Track.Source.Microphone, kind: lk.Track.Kind.Audio, setSubscribed: vi.fn() };

		setParticipantVolume('a', 'voice', 2);
		lastRoom().emit(lk.RoomEvent.TrackSubscribed, track, publication, a);

		const context = RecordingContext.instances.at(-1)!;
		const streams = context.createMediaStreamSource.mock.calls.map(call => (call as unknown as [RecordingStream])[0]);
		expect(streams.some(stream => stream.getTracks().includes(mediaStreamTrack))).toBe(true);
		expect(a.setVolume.mock.calls.filter(call => call[1] === lk.Track.Source.Microphone).at(-1)?.[0]).toBe(0);

		stopRecording();
		await flushRecording();
	});

	test('feeds unwatched screen-share audio into the recording mix while keeping speaker playback muted', async () => {
		await joinVoiceCall(room1);
		await flushRecording();
		await startRecording();
		const a = remoteParticipant('a');
		const mediaStreamTrack = { kind: 'audio' };
		const element = document.createElement('audio');
		const track = { kind: lk.Track.Kind.Audio, mediaStreamTrack, attach: vi.fn(() => element), detach: vi.fn(() => [element]) };
		const publication = { source: lk.Track.Source.ScreenShareAudio, kind: lk.Track.Kind.Audio, setSubscribed: vi.fn() };

		lastRoom().emit(lk.RoomEvent.TrackSubscribed, track, publication, a);

		expect(a.setVolume).toHaveBeenLastCalledWith(0, lk.Track.Source.ScreenShareAudio);
		const context = RecordingContext.instances.at(-1)!;
		const streams = context.createMediaStreamSource.mock.calls.map(call => (call as unknown as [RecordingStream])[0]);
		expect(streams.some(stream => stream.getTracks().includes(mediaStreamTrack))).toBe(true);

		watchScreenShare('a');
		expect(a.setVolume).toHaveBeenLastCalledWith(1, lk.Track.Source.ScreenShareAudio);
		unwatchScreenShare('a');
		expect(a.setVolume).toHaveBeenLastCalledWith(0, lk.Track.Source.ScreenShareAudio);

		stopRecording();
		await flushRecording();
	});

	test('does not mix the processed call microphone on top of the raw input when LiveKit republishes it', async () => {
		await joinVoiceCall(room1);
		await flushRecording();
		await startRecording();
		const room = lastRoom();
		const context = RecordingContext.instances[0];
		expect(context.createMediaStreamSource).toHaveBeenCalledOnce();

		room.emit(lk.RoomEvent.LocalTrackPublished, { source: lk.Track.Source.Microphone, track: room.localParticipant.microphoneTrack }, room.localParticipant);

		expect(context.createMediaStreamSource).toHaveBeenCalledOnce();

		stopRecording();
		await flushRecording();
	});
});
