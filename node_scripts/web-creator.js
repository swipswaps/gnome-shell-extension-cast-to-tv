var fs = require('fs');
var path = require('path');
var rangeParser = require('range-parser');
var bridge = require('./bridge');
var socket = require('./server-socket');
var encode = require('./encode');
var extract = require('./extract');
var shared = require('../shared');

exports.fileStream = function(req, res)
{
	var streamType = bridge.selection.streamType;
	var filePath = bridge.selection.filePath;

	if(!filePath)
		return res.sendStatus(404);

	/* Check if file exists */
	fs.access(filePath, fs.constants.F_OK, (err) =>
	{
		if(err) return res.sendStatus(404);

		/* Pipe picture stream and exit function */
		if(streamType === 'PICTURE')
		{
			res.setHeader('Access-Control-Allow-Origin', '*');
			res.setHeader('Content-Type', 'image/png');
			return fs.createReadStream(filePath).pipe(res);
		}

		/* Calculate file range for chunked streaming */
		fs.stat(filePath, (err, stats) =>
		{
			if(err) return res.sendStatus(404);

			res.setHeader('Access-Control-Allow-Origin', '*');
			res.setHeader('Content-Type', 'video/mp4');

			var total = stats.size;
			var range = req.headers.range;

			if(!range)
			{
				res.setHeader('Content-Length', total);
				res.statusCode = 200;
				return fs.createReadStream(filePath).pipe(res);
			}

			var part = rangeParser(total, range)[0];
			var chunksize = (part.end - part.start) + 1;
			var file = fs.createReadStream(filePath, {start: part.start, end: part.end});

			res.setHeader('Accept-Ranges', 'bytes');
			res.setHeader('Content-Range', 'bytes ' + part.start + '-' + part.end + '/' + total);
			res.setHeader('Content-Length', chunksize);
			res.statusCode = 206;

			return file.pipe(res);
		});
	});
}

exports.encodedStream = function(req, res)
{
	var filePath = bridge.selection.filePath;

	if(!filePath)
		return res.sendStatus(404);

	/* Prevent spawning more then one ffmpeg encode process */
	if(encode.streamProcess)
		return res.sendStatus(429);

	var streamType = bridge.selection.streamType;

	/* Check if file exists */
	fs.access(filePath, fs.constants.F_OK, (err) =>
	{
		if(err) return res.sendStatus(404);

		res.setHeader('Content-Type', 'video/x-matroska');
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Connection', 'keep-alive');
		res.statusCode = 200;

		if(streamType == 'VIDEO_ENCODE') encode.video().pipe(res);
		else if(streamType == 'VIDEO_VAAPI') encode.videoVaapi().pipe(res);
		else if(streamType == 'VIDEO_NVENC') encode.videoNvenc().pipe(res);
		else if(streamType == 'MUSIC') encode.musicVisualizer().pipe(res);
		else res.end();
	});
}

exports.subsStream = function(req, res)
{
	if(!bridge.selection.streamType.startsWith('VIDEO'))
		return res.sendStatus(204);

	var subsPath = bridge.selection.subsPath;

	if(bridge.config.receiverType !== 'playercast')
	{
		var parsedUrl = req._parsedUrl.pathname;

		if(!subsPath || parsedUrl == '/subswebplayer')
			subsPath = shared.vttSubsPath;
	}

	/* Check if file is specified and exists */
	if(subsPath)
	{
		fs.access(subsPath, fs.constants.F_OK, (err) =>
		{
			if(err) return res.sendStatus(404);

			res.writeHead(200, {
				'Access-Control-Allow-Origin': '*',
				'Content-Type': 'text/vtt'
			});

			return fs.createReadStream(subsPath).pipe(res);
		});
	}
	else
		return res.sendStatus(204);
}

exports.coverStream = function(req, res)
{
	if(!bridge.selection.streamType == 'MUSIC')
		return res.sendStatus(204);

	var coverPath = extract.coverPath;

	/* Playercast supports covers in media file */
	if(bridge.config.receiverType === 'playercast' && coverPath === 'muxed_image')
		return res.sendStatus(204);

	res.writeHead(200, {
		'Access-Control-Allow-Origin': '*',
		'Content-Type': 'image/png'
	});

	/* Use default cover when other does not exists */
	if(!coverPath)
	{
		fs.access(coverPath, fs.constants.F_OK, (err) =>
		{
			if(err) coverPath = path.join(__dirname + '/../webplayer/images/cover.png');

			return fs.createReadStream(coverPath).pipe(res);
		});
	}
	else
		return fs.createReadStream(coverPath).pipe(res);
}

exports.hlsStream = function(req, res)
{
	var filePath = shared.hlsDir + req.url;

	/* Check if stream segment exists */
	fs.access(filePath, fs.constants.F_OK, (err) =>
	{
		if(err) return res.sendStatus(404);

		fs.stat(filePath, (err, stats) =>
		{
			if(!err) res.setHeader('Content-Length', stats.size);

			res.setHeader('Access-Control-Allow-Origin', '*');
			res.setHeader('Content-Type', 'application/x-mpegURL');
			res.statusCode = 200;

			return fs.createReadStream(filePath).pipe(res);
		});
	});
}

exports.webConfig = function(req, res)
{
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Content-Type', 'text/css');

	var size = bridge.config.webplayerSubs;

	var webConfig = `@media {
	.plyr__captions{font-size:${5*size}vmin}
	.plyr:-webkit-full-screen .plyr__captions{font-size:${5*size}vmin}
	.plyr:-moz-full-screen .plyr__captions{font-size:${5*size}vmin}
	.plyr:-ms-fullscreen .plyr__captions{font-size:${5*size}vmin}
	.plyr:fullscreen .plyr__captions{font-size:${5*size}vmin}\n}`

	res.send(webConfig);
}

exports.getTemp = function(type, req, res)
{
	switch(type)
	{
		case 'config':
		case 'selection':
		case 'playlist':
		case 'status':
			res.send(bridge[type]);
			break;
		case 'playercasts':
			res.send(socket.playercasts);
			break;
		default:
			res.sendStatus(404);
			break;
	}
}

exports.postTemp = function(type, req, res)
{
	switch(type)
	{
		case 'config':
			bridge.updateConfig(req.body);
			res.sendStatus(200);
			break;
		case 'selection':
			bridge.updateSelection(req.body);
			res.sendStatus(200);
			break;
		case 'playlist':
			addItems = Object.values(req.body);
			const append = (req.query && req.query.append === 'true');
			bridge.updatePlaylist(addItems, append);
			res.sendStatus(200);
			break;
		case 'remote':
			bridge.updateRemote(req.body);
			res.sendStatus(200);
			break;
		default:
			res.sendStatus(404);
			break;
	}
}

exports.pageWrong = function(req, res)
{
	res.writeHead(302, { Location: '/' });
	res.end();
}
