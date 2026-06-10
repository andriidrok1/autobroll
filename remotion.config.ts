import {Config} from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.overrideWebpackConfig((config) => config);
