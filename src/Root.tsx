import React from 'react';
import {Composition, staticFile} from 'remotion';
import {MyVideo} from './Composition';
import {Showcase} from './Showcase';
import {CaptionedVideo} from './CaptionedVideo';
import {MultiClipVideo} from './MultiClipVideo';
import {totalDurationFrames} from './timeline';

// метаданные клипа считаются в node (scripts), студия читает готовый JSON —
// никакого парсинга видео в браузере (он там виснет на больших файлах)
const loadMeta = () =>
  fetch(staticFile('meta.json'))
    .then((r) => r.json())
    .catch(() => ({durationInFrames: 1152, fps: 30, width: 1080, height: 1920}));

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="MyVideo"
        component={MyVideo}
        durationInFrames={1152}
        fps={30}
        width={1080}
        height={1920}
        calculateMetadata={async () => await loadMeta()}
      />

      {/* Видео с умными субтитрами (clean minimal + акценты) */}
      <Composition
        id="Captioned"
        component={CaptionedVideo}
        durationInFrames={1152}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{words: [], accents: [], placements: []}}
        calculateMetadata={async ({props}) => {
          const [meta, words, accents, placements] = await Promise.all([
            loadMeta(),
            fetch(staticFile('transcript.json')).then((r) => r.json()),
            fetch(staticFile('accents.json')).then((r) => r.json()),
            fetch(staticFile('placement.json')).then((r) => r.json()).catch(() => []),
          ]);
          return {...meta, props: {...props, words, accents, placements}};
        }}
      />

      {/* Multi-clip editor timeline: trimmed takes back-to-back + music + captions */}
      <Composition
        id="MultiClip"
        component={MultiClipVideo}
        durationInFrames={300}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{clips: [], music: null, captions: [], accentColor: '#FFB020'}}
        calculateMetadata={async ({props}) => {
          const fps = 30;
          const {clips, music} = await fetch(staticFile('timeline.json'))
            .then((r) => r.json())
            .catch(() => ({clips: [], music: null}));
          const captions = await fetch(staticFile('captions.multi.json'))
            .then((r) => r.json())
            .catch(() => []);
          return {
            fps,
            width: 1080,
            height: 1920,
            durationInFrames: totalDurationFrames(clips, fps),
            props: {...props, clips, music, captions},
          };
        }}
      />

      {/* Сравнение вариантов графики на чистом фоне */}
      <Composition
        id="Showcase"
        component={Showcase}
        durationInFrames={120}
        fps={30}
        width={1080}
        height={1920}
      />
    </>
  );
};
