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
			// 本物の EventEmitter と同じく、emit の途中で付け外しされたハンドラはその emit では呼ばない
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
		// 値は本物の ScreenSharePresets と同じ
		h720fps15: preset(1280, 720, 1_500_000, 15),
		h720fps30: preset(1280, 720, 2_000_000, 30),
		h1080fps15: preset(1920, 1080, 2_500_000, 15),
		h1080fps30: preset(1920, 1080, 5_000_000, 30),
	};

	class FakeRemoteParticipant extends Emitter {
		trackPublications = new Map<string, any>();
		// 실제 audio 요소와 같이 0~1 밖의 음량은 받지 않는다
		setVolume = vi.fn((volume: number, _source?: string) => {
			if (!(volume >= 0 && volume <= 1)) throw new DOMException('The volume is outside the range [0, 1]', 'IndexSizeError');
		});
		constructor(public identity: string) {
			super();
		}
	}

	class FakeRoom extends Emitter {
		static instances: FakeRoom[] = [];
		static setup: ((room: FakeRoom) => void) | null = null;
		remoteParticipants = new Map<string, FakeRemoteParticipant>();
		canPlaybackAudio = true;
		publisher = { getConfiguration: vi.fn(() => ({ iceTransportPolicy: 'relay' as RTCIceTransportPolicy, bundlePolicy: 'max-bundle' as RTCBundlePolicy })), setConfiguration: vi.fn() };
		subscriber = { getConfiguration: vi.fn(() => ({ iceTransportPolicy: 'relay' as RTCIceTransportPolicy })), setConfiguration: vi.fn() };
		engine = { token: '', rtcConfig: {} as RTCConfiguration, reconnect: vi.fn(), pcManager: { publisher: { _pc: this.publisher }, subscriber: { _pc: this.subscriber }, triggerIceRestart: vi.fn().mockResolvedValue(undefined) } };
		localParticipant = {
			identity: 'https://local.test/users/me',
			// 本物と同じく、画面共有の映像を送っているあいだ true になる
			sid: 'PA_local',
			isScreenShareEnabled: false,
			// 本物と同じく、マイクのトラックは livekit-client が作り直す (restarted) ことも終わる (ended) こともある
			microphoneTrack: Object.assign(new Emitter(), { kind: 'audio', mediaStreamTrack: {} }),
			getTrackPublication: vi.fn(() => ({ track: this.localParticipant.microphoneTrack })),
			setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
			screenVideo: { source: 'screen_share', mediaStreamTrack: { applyConstraints: vi.fn().mockResolvedValue(undefined), getSettings: vi.fn(() => ({ width: 1280, height: 720, frameRate: 10 })) }, stop: vi.fn() },
			createScreenTracks: vi.fn(async () => [this.localParticipant.screenVideo]),
			publishTrack: vi.fn(async () => { this.localParticipant.isScreenShareEnabled = true; }),
			unpublishTrack: vi.fn().mockResolvedValue(undefined),
			setScreenShareEnabled: vi.fn(async (enabled: boolean, ..._options: unknown[]) => {
				this.localParticipant.isScreenShareEnabled = enabled;
			}),
		};
		connect = vi.fn(async (_url: string, token: string, options?: { rtcConfig?: RTCConfiguration }) => { this.engine.token = token; this.engine.rtcConfig = options?.rtcConfig ?? {}; });
		disconnect = vi.fn(async () => {
			this.emit(RoomEvent.Disconnected, DisconnectReason.CLIENT_INITIATED);
		});
		startAudio = vi.fn(async () => {
			this.canPlaybackAudio = true;
		});
		// 실제와 같게, 전환에 성공하면 ActiveDeviceChanged를 낸다
		switchActiveDevice = vi.fn(async (kind: string, deviceId: string) => {
			this.emit(RoomEvent.ActiveDeviceChanged, kind, deviceId);
			return true;
		});
		getActiveDevice = vi.fn((_kind: string): string | undefined => undefined);
		constructor(public options: unknown) {
			super();
			FakeRoom.instances.push(this);
			FakeRoom.setup?.(this);
		}
	}

	const analyser = { analyser: { fftSize: 512, context: { state: 'running' as AudioContextState }, getFloatTimeDomainData: vi.fn((data: Float32Array) => data.fill(0)) }, cleanup: vi.fn().mockResolvedValue(undefined) };
	const createAudioAnalyser = vi.fn(() => analyser);
	const supportsAudioOutputSelection = vi.fn(() => true);
	return { analyser, createAudioAnalyser, supportsAudioOutputSelection, Emitter, RoomEvent, TrackEvent, DisconnectReason, Track, ScreenSharePresets, VideoPreset, VideoQuality, FakeRoom, FakeRemoteParticipant };
});

vi.mock('livekit-client', async () => ({
	// 브라우저 판정은 실제 구현을 쓴다 (navigator.userAgent를 읽는다)
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

const boostMock = vi.hoisted(() => {
	const instances: any[] = [];
	return { instances, failSet: false, initialReady: true };
});
vi.mock('@/utility/voice-boost.js', async importOriginal => {
	const original = await importOriginal<typeof import('@/utility/voice-boost.js')>();
	class FakeVoiceBoost {
		blocked = false;
		ready = boostMock.initialReady;
		set = vi.fn((_track: unknown, _gain: number) => !boostMock.failSet);
		isReady = vi.fn((_track: unknown) => this.ready);
		prepare = vi.fn();
		release = vi.fn();
		setSinkId = vi.fn().mockResolvedValue(undefined);
		resume = vi.fn(async () => { this.blocked = false; this.options.onBlockedChange?.(false); });
		dispose = vi.fn();
		constructor(public options: { onBlockedChange?: (blocked: boolean) => void; onReadyChange?: () => void; useElement?: boolean; keepMediaCategory?: boolean; settleDelayMs?: number }) {
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

import { HANDOVER_DELAY_MS, SETTLE_DELAY_MS } from '@/utility/voice-boost.js';
import { prefer as mockedPrefer } from '@/preferences.js';
import { canSelectAudioOutput, joinVoiceCall, leaveVoiceCall, participantVolume, prepareBoostAudio, resumeAudio, selectAudioDevice, setDeafened, setParticipantVolume, unwatchScreenShare, voiceCall, watchScreenShare } from '@/utility/voice-call.js';

const prefer = mockedPrefer as unknown as FakePrefer;
const room1 = { id: 'r1', name: 'room 1' } as any;
const room2 = { id: 'r2', name: 'room 2' } as any;
const lastRoom = () => lk.FakeRoom.instances[lk.FakeRoom.instances.length - 1];

function remoteParticipant(identity: string) {
	const participant = new lk.FakeRemoteParticipant(identity);
	lastRoom().remoteParticipants.set(identity, participant);
	return participant;
}

beforeEach(() => {
	lk.FakeRoom.instances.length = 0;
	boostMock.instances.length = 0;
	boostMock.failSet = false;
	boostMock.initialReady = true;
	lk.supportsAudioOutputSelection.mockReset().mockReturnValue(true);
	lk.analyser.analyser.getFloatTimeDomainData.mockImplementation((data: Float32Array) => data.fill(0));
	lk.analyser.analyser.context.state = 'running';
	lk.analyser.cleanup.mockClear();
	lk.createAudioAnalyser.mockClear();
	lk.FakeRoom.setup = null;
	mocks.misskeyApi.mockReset().mockResolvedValue({ url: 'https://local.test/livekit', token: 't' });
	mocks.toast.mockReset();
	mocks.alert.mockReset();
	mocks.confirm.mockReset().mockResolvedValue({ canceled: false });
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
});

describe('voice call volume range', () => {
	test('keeps participant volume within 0 to 200%', async () => {
		prefer.commit('voiceCall.participantVolumes', { b: 1.8, c: 3 });
		prefer.commit('voiceCall.screenShareVolumes', { b: -0.5 });
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		remoteParticipant('b');
		watchScreenShare('a');
		watchScreenShare('b');

		setParticipantVolume('a', 'voice', 1.5);
		expect(prefer.s['voiceCall.participantVolumes']).toMatchObject({ a: 1.5 });
		setParticipantVolume('a', 'voice', 5);
		expect(prefer.s['voiceCall.participantVolumes']).toMatchObject({ a: 2 });
		setParticipantVolume('a', 'screenShare', -1);
		expect(prefer.s['voiceCall.screenShareVolumes']).toMatchObject({ a: 0 });
		expect(a.setVolume).toHaveBeenLastCalledWith(0, lk.Track.Source.ScreenShareAudio);

		// 기존 저장값 (0~1)은 그대로 쓰고, 범위 밖은 0~2로 맞춘다
		expect(participantVolume('b', 'voice')).toBe(1.8);
		expect(participantVolume('c', 'voice')).toBe(2);
		expect(participantVolume('b', 'screenShare')).toBe(0);

		// 저장값이 1을 넘어도 audio 요소에는 0~1만 전달한다 (가짜 참가자는 범위 밖 값에서 예외를 낸다)
		expect(() => { setDeafened(true); setDeafened(false); }).not.toThrow();
	});
});

describe('voice volume above 100%', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const mic = () => lk.Track.Source.Microphone;
	const shareAudio = () => lk.Track.Source.ScreenShareAudio;
	const subscribeAudio = (participant: any, source: string, element = document.createElement('audio')) => {
		const track = { kind: lk.Track.Kind.Audio, mediaStreamTrack: {}, attachedElements: [element], attach: vi.fn(() => element), detach: vi.fn(() => [element]) };
		const publication = { source, kind: lk.Track.Kind.Audio, setSubscribed: vi.fn() };
		lastRoom().emit(lk.RoomEvent.TrackSubscribed, track, publication, participant);
		return { track, publication, element };
	};
	const boost = () => boostMock.instances[boostMock.instances.length - 1];
	// participant.setVolume에 마지막으로 전달된, 해당 종류의 음량
	const volumeOf = (participant: any, source: string) => participant.setVolume.mock.calls.filter((call: unknown[]) => call[1] === source).at(-1)?.[0];
	const boosted = (track: unknown) => (boost()?.set.mock.calls ?? []).some((call: unknown[]) => call[0] === track);

	test('plays at 100% or below through the audio element only', async () => {
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const { track } = subscribeAudio(a, mic());
		expect(volumeOf(a, mic())).toBe(1);

		setParticipantVolume('a', 'voice', 0.4);

		expect(volumeOf(a, mic())).toBe(0.4);
		expect(boosted(track)).toBe(false);
	});

	const volumeSignals = (listener: { mock: { calls: unknown[][] } }) => listener.mock.calls
		.filter(call => call[0] === 'volumechange')
		.map(call => (call[2] as AddEventListenerOptions).signal);

	test('detaches the volume handler of an unsubscribed track from an element that livekit recycles for the next track', async () => {
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const element = document.createElement('audio');
		const addListener = vi.spyOn(element, 'addEventListener');
		const first = subscribeAudio(a, mic(), element);
		lastRoom().emit(lk.RoomEvent.TrackUnsubscribed, first.track, first.publication, a);

		subscribeAudio(a, mic(), element);

		const [firstSignal, secondSignal] = volumeSignals(addListener);
		expect(firstSignal?.aborted).toBe(true);
		expect(secondSignal?.aborted).toBe(false);
	});

	test('detaches the volume handlers when the call ends', async () => {
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const element = document.createElement('audio');
		const addListener = vi.spyOn(element, 'addEventListener');
		subscribeAudio(a, mic(), element);

		await leaveVoiceCall();

		expect(volumeSignals(addListener).map(signal => signal?.aborted)).toEqual([true]);
	});

	test('removes the audio elements of the ended call from the page even when livekit did not report their tracks', async () => {
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const element = document.createElement('audio');
		subscribeAudio(a, mic(), element);
		expect(document.body.contains(element)).toBe(true);

		await leaveVoiceCall();

		expect(document.body.contains(element)).toBe(false);
	});

	test('does not wake the amplifier for a slider gesture on browsers that start audio without one', async () => {
		vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0');
		await joinVoiceCall(room1);

		prepareBoostAudio();

		expect(boostMock.instances).toHaveLength(0);
	});

	test('wakes the amplifier for a slider gesture in Safari on a Mac', async () => {
		vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.4 Safari/605.1.15');
		await joinVoiceCall(room1);

		prepareBoostAudio();

		expect(boost().prepare).toHaveBeenCalledOnce();
	});

	test('does not keep a silent media element for the amplifier on other platforms', async () => {
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		subscribeAudio(a, mic());

		setParticipantVolume('a', 'voice', 1.5);

		expect(boost().options.keepMediaCategory).toBe(false);
	});

	test('amplifies above 100% with the audio element silenced, and goes back below it', async () => {
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const { track } = subscribeAudio(a, mic());

		setParticipantVolume('a', 'voice', 1.5);
		expect(prefer.s['voiceCall.participantVolumes']).toMatchObject({ a: 1.5 });
		expect(volumeOf(a, mic())).toBe(0);
		expect(boost().set).toHaveBeenLastCalledWith(track, 1.5);

		setParticipantVolume('a', 'voice', 2);
		expect(boost().set).toHaveBeenLastCalledWith(track, 2);
		expect(volumeOf(a, mic())).toBe(0);

		setParticipantVolume('a', 'voice', 0.8);
		expect(boost().release).toHaveBeenCalledWith(track);
		expect(volumeOf(a, mic())).toBe(0.8);
	});

	test('releases the amplifier a little after the original element came back in Chromium', async () => {
		vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36');
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const { track } = subscribeAudio(a, mic());
		setParticipantVolume('a', 'voice', 1.5);

		setParticipantVolume('a', 'voice', 0.8);

		expect(boost().release).toHaveBeenCalledWith(track, HANDOVER_DELAY_MS);
		expect(boost().options.settleDelayMs).toBe(SETTLE_DELAY_MS);
		expect(volumeOf(a, mic())).toBe(0.8);
	});

	test('amplifies a track that arrives after the volume was set', async () => {
		prefer.commit('voiceCall.participantVolumes', { a: 1.7 });
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const { track } = subscribeAudio(a, mic());
		expect(boost().set).toHaveBeenCalledWith(track, 1.7);
		expect(volumeOf(a, mic())).toBe(0);
	});

	test('amplifies the shared screen audio only while watching it', async () => {
		prefer.commit('voiceCall.screenShareVolumes', { a: 2 });
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const { track } = subscribeAudio(a, shareAudio());
		expect(boosted(track)).toBe(false);
		expect(volumeOf(a, shareAudio())).toBe(0);

		watchScreenShare('a');
		expect(boost().set).toHaveBeenLastCalledWith(track, 2);
		expect(volumeOf(a, shareAudio())).toBe(0);

		unwatchScreenShare('a');
		expect(boost().release).toHaveBeenCalledWith(track);
		expect(volumeOf(a, shareAudio())).toBe(0);
	});

	test('deafening silences an amplified track and undeafening brings the amplification back', async () => {
		prefer.commit('voiceCall.participantVolumes', { a: 1.6 });
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const { track } = subscribeAudio(a, mic());

		setDeafened(true);
		expect(boost().release).toHaveBeenCalledWith(track);
		expect(volumeOf(a, mic())).toBe(0);
		boost().set.mockClear();
		setDeafened(false);
		expect(boost().set).toHaveBeenCalledWith(track, 1.6);
	});

	test('follows the output device chosen while amplifying, and the one chosen before', async () => {
		prefer.commit('voiceCall.outputDeviceId', 'speaker-1');
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		subscribeAudio(a, mic());
		setParticipantVolume('a', 'voice', 1.5);
		expect(boost().setSinkId).toHaveBeenCalledWith('speaker-1');

		await selectAudioDevice('audiooutput', 'speaker-2');
		expect(lastRoom().switchActiveDevice).toHaveBeenCalledWith('audiooutput', 'speaker-2');
		expect(boost().setSinkId).toHaveBeenLastCalledWith('speaker-2');
	});

	test('releases the amplification when the track is unsubscribed, and for the track that replaces it', async () => {
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const first = subscribeAudio(a, mic());
		setParticipantVolume('a', 'voice', 1.5);

		lastRoom().emit(lk.RoomEvent.TrackUnsubscribed, first.track, first.publication, a);
		expect(boost().release).toHaveBeenCalledWith(first.track);

		const second = subscribeAudio(a, mic());
		expect(boost().set).toHaveBeenLastCalledWith(second.track, 1.5);
		expect(boost().release).not.toHaveBeenCalledWith(second.track);
	});

	test('shows the sound-on action for an autoplay-blocked amplified track and resumes it with the same action', async () => {
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		subscribeAudio(a, mic());
		setParticipantVolume('a', 'voice', 1.5);
		expect(voiceCall.audioBlocked).toBe(false);

		boost().blocked = true;
		boost().options.onBlockedChange?.(true);
		expect(voiceCall.audioBlocked).toBe(true);

		await resumeAudio();
		expect(lastRoom().startAudio).toHaveBeenCalled();
		expect(boost().resume).toHaveBeenCalled();
		expect(voiceCall.audioBlocked).toBe(false);
	});

	test('disposes everything when leaving, and starts clean in the next call', async () => {
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		subscribeAudio(a, mic());
		setParticipantVolume('a', 'voice', 1.5);
		const first = boost();

		await leaveVoiceCall();
		expect(first.dispose).toHaveBeenCalled();
		expect(voiceCall.audioBlocked).toBe(false);

		await joinVoiceCall(room2);
		const b = remoteParticipant('a');
		const second = subscribeAudio(b, mic());
		expect(boost()).not.toBe(first);
		expect(boost().set).toHaveBeenCalledWith(second.track, 1.5);
	});

	test('disposes the amplification when the connection drops', async () => {
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		subscribeAudio(a, mic());
		setParticipantVolume('a', 'voice', 1.5);
		const first = boost();
		lastRoom().emit(lk.RoomEvent.Disconnected, lk.DisconnectReason.UNKNOWN_REASON);
		expect(first.dispose).toHaveBeenCalled();
	});

	test('keeps the new call amplified when the previous call finishes disconnecting late', async () => {
		prefer.commit('voiceCall.participantVolumes', { a: 2 });
		await joinVoiceCall(room1);
		const first = lastRoom();
		let finishDisconnect!: () => void;
		first.disconnect.mockImplementationOnce(() => new Promise<void>(resolve => {
			finishDisconnect = resolve;
		}));

		const leaving = leaveVoiceCall();
		await joinVoiceCall(room2);
		const a = remoteParticipant('a');
		const { track } = subscribeAudio(a, mic());
		const second = boost();
		expect(second.set).toHaveBeenCalledWith(track, 2);

		finishDisconnect();
		await leaving;

		expect(second.dispose).not.toHaveBeenCalled();
		boost().set.mockClear();
		setParticipantVolume('a', 'voice', 1.5);
		expect(boost()).toBe(second);
		expect(second.set).toHaveBeenCalledWith(track, 1.5);
	});

	test('plays at 100% through the audio element when the amplification cannot be created', async () => {
		prefer.commit('voiceCall.participantVolumes', { a: 1.5 });
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		boostMock.failSet = true;
		subscribeAudio(a, mic());

		expect(volumeOf(a, mic())).toBe(1);
		expect(voiceCall.audioBlocked).toBe(false);
	});

	test('starts the sound-on actions together and clears the blocked state afterwards', async () => {
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		subscribeAudio(a, mic());
		setParticipantVolume('a', 'voice', 1.5);
		let finishStart!: () => void;
		lastRoom().startAudio.mockImplementationOnce(() => new Promise<void>(resolve => { finishStart = resolve; }));
		boost().blocked = true;
		boost().options.onBlockedChange?.(true);
		expect(voiceCall.audioBlocked).toBe(true);

		const resuming = resumeAudio();

		expect(lastRoom().startAudio).toHaveBeenCalled();
		expect(boost().resume).toHaveBeenCalled();
		finishStart();
		await resuming;

		expect(voiceCall.audioBlocked).toBe(false);
	});

	test('still resumes the amplified sound when starting the elements fails', async () => {
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		subscribeAudio(a, mic());
		setParticipantVolume('a', 'voice', 1.5);
		lastRoom().startAudio.mockRejectedValueOnce(new Error('NotAllowedError'));

		await resumeAudio();

		expect(boost().resume).toHaveBeenCalled();
	});

	test('releases the amplification of a track that a new track for the same source replaces', async () => {
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const first = subscribeAudio(a, mic());
		setParticipantVolume('a', 'voice', 1.5);

		const second = subscribeAudio(a, mic());

		expect(boost().release).toHaveBeenCalledWith(first.track);
		expect(boost().set).toHaveBeenLastCalledWith(second.track, 1.5);
	});

	test('removes the audio element when the track is unsubscribed even if it was already detached', async () => {
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const { track, publication, element } = subscribeAudio(a, mic());
		expect(document.body.contains(element)).toBe(true);
		// 실제 LiveKit은 구독 해제를 알리기 전에 트랙에서 요소를 먼저 뗀다
		track.detach.mockReturnValue([]);

		lastRoom().emit(lk.RoomEvent.TrackUnsubscribed, track, publication, a);

		expect(document.body.contains(element)).toBe(false);
	});
});

describe('voice volume on iPhone and iPad', () => {
	const mic = () => lk.Track.Source.Microphone;
	const shareAudio = () => lk.Track.Source.ScreenShareAudio;
	const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/18.7 Mobile/15E148 Safari/604.1';
	const subscribeAudio = (participant: any, source: string) => {
		const element = document.createElement('audio');
		// iPhone의 audio 요소처럼 volume을 써도 무시하고 항상 1이다
		Object.defineProperty(element, 'volume', { get: () => 1, set: () => {} });
		const track = { kind: lk.Track.Kind.Audio, mediaStreamTrack: {}, attachedElements: [element], attach: vi.fn(() => element), detach: vi.fn(() => [element]) };
		const publication = { source, kind: lk.Track.Kind.Audio, setSubscribed: vi.fn() };
		lastRoom().emit(lk.RoomEvent.TrackSubscribed, track, publication, participant);
		return { track, publication, element };
	};
	const boost = () => boostMock.instances[boostMock.instances.length - 1];

	beforeEach(() => {
		vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(IPHONE_UA);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test.each([0.5, 1.5, 2])('plays %s through the amplifier with the original element muted', async volume => {
		prefer.commit('voiceCall.participantVolumes', { a: volume });
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const { track, element } = subscribeAudio(a, mic());

		expect(boost().set).toHaveBeenCalledWith(track, volume);
		expect(element.muted).toBe(true);
	});

	test('plays 100% through the original element only', async () => {
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const { element } = subscribeAudio(a, mic());

		expect(boostMock.instances.flatMap(instance => instance.set.mock.calls)).toHaveLength(0);
		expect(element.muted).toBe(false);
	});

	test('mutes the original element at 0% without using the amplifier', async () => {
		prefer.commit('voiceCall.participantVolumes', { a: 0 });
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const { element } = subscribeAudio(a, mic());

		expect(boostMock.instances.flatMap(instance => instance.set.mock.calls)).toHaveLength(0);
		expect(element.muted).toBe(true);
	});

	test('mutes the original element when the speaker is turned off, and unmutes it when turned on', async () => {
		prefer.commit('voiceCall.participantVolumes', { a: 0.5 });
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const { track, element } = subscribeAudio(a, mic());

		setDeafened(true);
		expect(boost().release).toHaveBeenCalledWith(track);
		expect(element.muted).toBe(true);

		boost().set.mockClear();
		setDeafened(false);
		expect(boost().set).toHaveBeenCalledWith(track, 0.5);
	});

	test('mutes shared screen audio that is not being watched', async () => {
		prefer.commit('voiceCall.screenShareVolumes', { a: 1 });
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const { element } = subscribeAudio(a, shareAudio());
		expect(element.muted).toBe(true);

		watchScreenShare('a');
		expect(element.muted).toBe(false);
	});

	test('keeps the original element playing until the amplifier can make sound, then mutes it', async () => {
		prefer.commit('voiceCall.participantVolumes', { a: 0.5 });
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		prepareBoostAudio();
		boost().ready = false;

		const { element } = subscribeAudio(a, mic());
		expect(element.muted).toBe(false);

		boost().ready = true;
		boost().options.onReadyChange?.();

		expect(element.muted).toBe(true);
	});

	test('unmutes the original element again when the amplifier stops being able to make sound', async () => {
		prefer.commit('voiceCall.participantVolumes', { a: 1.5 });
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const { element } = subscribeAudio(a, mic());
		expect(element.muted).toBe(true);

		boost().ready = false;
		boost().options.onReadyChange?.();

		expect(element.muted).toBe(false);
	});

	test('leaves the original element as it was when the amplifier cannot be created', async () => {
		boostMock.failSet = true;
		prefer.commit('voiceCall.participantVolumes', { a: 0.5 });
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const { element } = subscribeAudio(a, mic());

		expect(element.muted).toBe(false);
	});

	test('mutes the element again when livekit unmutes it', async () => {
		prefer.commit('voiceCall.participantVolumes', { a: 0.5 });
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const { element } = subscribeAudio(a, mic());
		expect(element.muted).toBe(true);

		element.muted = false;
		element.dispatchEvent(new Event('volumechange'));

		expect(element.muted).toBe(true);
	});

	test('mutes the element again after the sound-on action unmuted it', async () => {
		prefer.commit('voiceCall.participantVolumes', { a: 0.5 });
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const { element } = subscribeAudio(a, mic());
		lastRoom().startAudio.mockImplementationOnce(async () => { element.muted = false; });

		await resumeAudio();

		expect(element.muted).toBe(true);
	});

	test('does not mute the element for a track that is no longer subscribed', async () => {
		prefer.commit('voiceCall.participantVolumes', { a: 0 });
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const { track, publication, element } = subscribeAudio(a, mic());
		lastRoom().emit(lk.RoomEvent.TrackUnsubscribed, track, publication, a);

		element.muted = false;
		element.dispatchEvent(new Event('volumechange'));

		expect(element.muted).toBe(false);
	});

	test('leaves the muted state of elements alone on other platforms', async () => {
		vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140 Safari/537.36');
		prefer.commit('voiceCall.participantVolumes', { a: 0 });
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const { element } = subscribeAudio(a, mic());

		expect(a.setVolume).toHaveBeenCalledWith(0, mic());
		expect(element.muted).toBe(false);
	});

	test('wakes the amplifier synchronously for a slider gesture', async () => {
		await joinVoiceCall(room1);

		prepareBoostAudio();

		expect(boost().prepare).toHaveBeenCalledOnce();
	});

	test('keeps a silent media element for the amplifier', async () => {
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		subscribeAudio(a, mic());

		setParticipantVolume('a', 'voice', 0.5);

		expect(boost().options.keepMediaCategory).toBe(true);
	});

	test('ignores a slider gesture when there is no call', () => {
		expect(() => prepareBoostAudio()).not.toThrow();
		expect(boostMock.instances).toHaveLength(0);
	});
});

describe('amplified volume on other platforms', () => {
	const mic = () => lk.Track.Source.Microphone;
	const subscribeAudio = (participant: any) => {
		const element = document.createElement('audio');
		const track = { kind: lk.Track.Kind.Audio, mediaStreamTrack: {}, attachedElements: [element], attach: vi.fn(() => element), detach: vi.fn(() => [element]) };
		lastRoom().emit(lk.RoomEvent.TrackSubscribed, track, { source: mic(), kind: lk.Track.Kind.Audio, setSubscribed: vi.fn() }, participant);
		return { track, element };
	};
	const boost = () => boostMock.instances[boostMock.instances.length - 1];
	const volumeOf = (participant: any) => participant.setVolume.mock.calls.filter((call: unknown[]) => call[1] === mic()).at(-1)?.[0];

	test('keeps the original volume until the amplifier can make sound, then silences it', async () => {
		prefer.commit('voiceCall.participantVolumes', { a: 2 });
		boostMock.initialReady = false;
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');

		subscribeAudio(a);
		expect(volumeOf(a)).toBe(1);

		boost().ready = true;
		boost().options.onReadyChange?.();
		expect(volumeOf(a)).toBe(0);
	});

	test('plays below 100% through the original element only', async () => {
		prefer.commit('voiceCall.participantVolumes', { a: 0.5 });
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		subscribeAudio(a);

		expect(boostMock.instances.flatMap(instance => instance.set.mock.calls)).toHaveLength(0);
		expect(volumeOf(a)).toBe(0.5);
	});

	test('creates the amplifier with an element only where livekit can select the output', async () => {
		lk.supportsAudioOutputSelection.mockReturnValue(false);
		prefer.commit('voiceCall.participantVolumes', { a: 2 });
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		subscribeAudio(a);
		expect(boost().options.useElement).toBe(false);

		await leaveVoiceCall();
		lk.supportsAudioOutputSelection.mockReturnValue(true);
		await joinVoiceCall(room2);
		const b = remoteParticipant('a');
		subscribeAudio(b);
		expect(boost().options.useElement).toBe(true);
	});
});

describe('output device selection', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const boost = () => boostMock.instances[boostMock.instances.length - 1];
	const startAmplifying = async () => {
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const element = document.createElement('audio');
		const track = { kind: lk.Track.Kind.Audio, mediaStreamTrack: {}, attachedElements: [element], attach: vi.fn(() => element), detach: vi.fn(() => [element]) };
		lastRoom().emit(lk.RoomEvent.TrackSubscribed, track, { source: lk.Track.Source.Microphone, kind: lk.Track.Kind.Audio, setSubscribed: vi.fn() }, a);
		setParticipantVolume('a', 'voice', 1.5);
	};

	test('reports whether livekit supports choosing the output device', async () => {
		lk.supportsAudioOutputSelection.mockReturnValue(false);
		await expect(canSelectAudioOutput()).resolves.toBe(false);

		lk.supportsAudioOutputSelection.mockReturnValue(true);
		await expect(canSelectAudioOutput()).resolves.toBe(true);
	});

	test('moves the amplifier when livekit changes the output device by itself', async () => {
		await startAmplifying();

		lastRoom().emit(lk.RoomEvent.ActiveDeviceChanged, 'audiooutput', 'speaker-3');

		expect(boost().setSinkId).toHaveBeenCalledWith('speaker-3');
	});

	test('uses the output device livekit changed to for an amplifier created later', async () => {
		await joinVoiceCall(room1);
		lastRoom().emit(lk.RoomEvent.ActiveDeviceChanged, 'audiooutput', 'speaker-3');
		const a = remoteParticipant('a');
		const element = document.createElement('audio');
		const track = { kind: lk.Track.Kind.Audio, mediaStreamTrack: {}, attachedElements: [element], attach: vi.fn(() => element), detach: vi.fn(() => [element]) };
		lastRoom().emit(lk.RoomEvent.TrackSubscribed, track, { source: lk.Track.Source.Microphone, kind: lk.Track.Kind.Audio, setSubscribed: vi.fn() }, a);

		setParticipantVolume('a', 'voice', 1.5);

		expect(boost().setSinkId).toHaveBeenCalledWith('speaker-3');
	});

	test('does not move the amplifier when livekit changes a device other than the output', async () => {
		await startAmplifying();

		lastRoom().emit(lk.RoomEvent.ActiveDeviceChanged, 'audioinput', 'mic-2');
		lastRoom().emit(lk.RoomEvent.ActiveDeviceChanged, 'videoinput', 'camera-2');

		expect(boost().setSinkId).not.toHaveBeenCalled();
	});

	test('ignores an output device change that an earlier call reports', async () => {
		await startAmplifying();
		const earlier = lastRoom();
		await leaveVoiceCall();
		await startAmplifying();
		const later = boost();

		earlier.emit(lk.RoomEvent.ActiveDeviceChanged, 'audiooutput', 'speaker-3');

		expect(later.setSinkId).not.toHaveBeenCalledWith('speaker-3');
	});

	test('does not reject when switching the output device fails, and does not move the amplifier', async () => {
		await startAmplifying();
		lastRoom().switchActiveDevice.mockRejectedValueOnce(new Error('cannot switch audio output, the current browser does not support it'));

		await expect(selectAudioDevice('audiooutput', 'speaker-2')).resolves.toBeUndefined();

		expect(boost().setSinkId).not.toHaveBeenCalledWith('speaker-2');
	});

	test('logs why switching the output device failed', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await joinVoiceCall(room1);
		const reason = new Error('NotFoundError');
		lastRoom().switchActiveDevice.mockRejectedValueOnce(reason);

		await selectAudioDevice('audiooutput', 'speaker-2');

		expect(warn).toHaveBeenCalledWith(expect.any(String), reason);
	});

	test('logs why switching to the saved output device failed when joining', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const reason = new Error('NotFoundError');
		prefer.commit('voiceCall.outputDeviceId', 'speaker-1');
		lk.FakeRoom.setup = room => { room.switchActiveDevice.mockRejectedValue(reason); };

		await joinVoiceCall(room1);

		await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.any(String), reason));
	});

	test('moves the amplifier after livekit switched the output device', async () => {
		await startAmplifying();

		await selectAudioDevice('audiooutput', 'speaker-2');

		expect(boost().setSinkId).toHaveBeenCalledWith('speaker-2');
	});

	test('does not use a rejected output device for an amplifier created later', async () => {
		await joinVoiceCall(room1);
		lastRoom().switchActiveDevice.mockRejectedValueOnce(new Error('unsupported'));
		await selectAudioDevice('audiooutput', 'speaker-2');
		const a = remoteParticipant('a');
		const element = document.createElement('audio');
		const track = { kind: lk.Track.Kind.Audio, mediaStreamTrack: {}, attachedElements: [element], attach: vi.fn(() => element), detach: vi.fn(() => [element]) };
		lastRoom().emit(lk.RoomEvent.TrackSubscribed, track, { source: lk.Track.Source.Microphone, kind: lk.Track.Kind.Audio, setSubscribed: vi.fn() }, a);

		setParticipantVolume('a', 'voice', 1.5);

		expect(boost().setSinkId).not.toHaveBeenCalledWith('speaker-2');
	});

	test('shows the existing notice when switching the microphone fails', async () => {
		await joinVoiceCall(room1);
		lastRoom().switchActiveDevice.mockRejectedValueOnce(new Error('NotFoundError'));

		await expect(selectAudioDevice('audioinput', 'mic-2')).resolves.toBeUndefined();

		expect(mocks.toast).toHaveBeenCalledWith(expect.any(String));
	});

	test('does not switch to a saved output device the browser cannot select', async () => {
		lk.supportsAudioOutputSelection.mockReturnValue(false);
		prefer.commit('voiceCall.outputDeviceId', 'speaker-1');

		await joinVoiceCall(room1);

		expect(lastRoom().switchActiveDevice).not.toHaveBeenCalledWith('audiooutput', 'speaker-1');
	});

	test('does not hand a saved output device that failed to switch to the amplifier', async () => {
		prefer.commit('voiceCall.outputDeviceId', 'speaker-1');
		lk.FakeRoom.setup = room => { room.switchActiveDevice.mockRejectedValue(new Error('unsupported')); };
		await startAmplifying();

		await vi.waitFor(() => expect(lastRoom().switchActiveDevice).toHaveBeenCalled());

		expect(boost().setSinkId).not.toHaveBeenCalledWith('speaker-1');
	});
});
