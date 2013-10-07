var express = require('express');
var uuid = require('node-uuid');
var command_line = require('optimist').argv;

var app = express()
app.use(express.logger());
app.use(express.cookieParser());
app.use(express.bodyParser({keepExtensions: true, uploadDir:'./upload'}));

// variables
var running = false;
var session={};

// Apple Push Notification
var apn = require('./apn.js');

// Redis
var redis = require('redis-url').connect(process.env.REDISTOGO_URL);
redis.on("error", function (err) {
    console.log(err);
	// TODO quit
});

redis.on("ready", function () {
	// TODO called multiple times
    console.log("Redis ready!");
	if (!running) {
		running = true;
		main();		
	} else {
		console.log("Message ignored");
	}
});

// model
var model = require('./model.js');
model.init(apn, redis);

// config
var ACTIVE_TIMEOUT = 30*60*1000; // 30 minutes

function requireAuthentication(req, res, next) {
	var user = req.cookies.user;
	var auth_id = req.cookies.auth_id;

	if (user == undefined || user == '' ||
		auth_id == undefined || auth_id == '' ||
		session[user] != auth_id) {
		res.json(401, {msg:'Log in first!', id:user, auth:auth_id});
		return;
	}
	// load user
	redis.get('user:' + user, function(err,user_obj){
		if (err || !user_obj) {
			res.json(500, {msg:err});
			return;
		}
		req.user = model.create_user(user_obj);
		if (req.user.partner) {
			redis.get('user:' + req.user.partner, function(err, obj){
				if (err || !obj) {
					console.log("error when fetching partner of " + req.user.id);
					res.json(500);
				} else {
					req.partner = model.create_user(obj);
					next();
				}
			});					
		} else {
			next();
		}
	});
}

function signin(user_obj, res) {
	var auth_id = uuid.v4();
	session[user_obj.id] = auth_id;
	// TODO expire
	res.cookie('user', user_obj.id, {maxAge: 365*24*60*60*1000});
	res.cookie('auth_id', auth_id, {maxAge: 365*24*60*60*1000});
	
	console.log('Send user obj:' + JSON.stringify(user_obj.response()));
	
	res.json(200, user_obj.response());
}

function main() {
	app.all('/api/*', requireAuthentication);
	
	app.get('/api/dump', function(req, res){
		res.send(200, JSON.stringify(req.user));
		//TODO dump timeline
	});
	
	app.post('/signup', function(req, res) {	
		var user = req.param('user');
		var pwd = req.param('pwd');
		redis.get('user:' + user, function(err,obj){
			if (err) {
				console.log('signup read error' + err);
				res.status(500).json({msg:err});
				return;
			}
			
			if (obj){
				res.status(500).json({msg: "User already exists"});
				return;
			}

			var user_obj = model.create_user(JSON.stringify({
				id:user,
				pass:pwd,
				male:true,
			}));
			
			redis.set('user:' + user, JSON.stringify(user_obj),
				function(err, redis_res){
					if (err) {
						console.log('signup write error');
						res.status(500).json({msg:'internal error'});
					}
					else {
						signin(user_obj,res);
					}
				}
			);
		});
	});
	
	app.post('/signin', function(req, res){
		var user = req.param('user');
		var pwd = req.param('pwd');
		redis.get('user:' + user, function(err,obj){
			if (err != null || obj == null) {
				res.status(500).json({msg:'User not existent'});	
				return;		
			}
			var user_obj = model.create_user(obj);
   			if (user_obj.pass == pwd) {
   				signin(user_obj,res);
   			} else {
   				res.status(500).json({msg:'Wrong password', user:user_obj});
   			}
		});
	});

	app.get('/signout/', function(req, res){
		if (session[req.cookies.user] == req.cookies.auth_id){
			delete session[req.cookies.user];
			res.clearCookie('user');
			res.clearCookie('auth_id');
			res.json(200, {msg:'Successful'});
		} else {
			res.json(200, {msg:'Nothing happens'});
		}
	});

	app.post('/api/pair', function(req,res){
		var target = req.param('user');
		if (!target || target.length == 0 || target == req.user.id) {
			res.json(500, {msg:'Invalid param'});
		} else if (req.user.partner) {
			res.json(500, {msg:'How come you already have a partner?'});
		} else if (req.user.incoming != undefined && req.user.incoming == false) {
			res.json(500, {msg:'Previous request already sent'});
		} else {
			redis.get('user:' + target, function(err,user_str){
				if (err || !user_str) {
					res.json(500, {msg:'Invalid user id:' + target});
					return;
				}
				var user_obj = model.create_user(user_str);
				// Other user cancelled the request or already partnered with sb else
				if (user_obj.partner ||
					user_obj.request && user_obj.request != req.user.id) {
					res.json(500, {msg:'User already paired'});
					return;
				}

				if (req.user.request && req.user.request == target) {
					// confirming incoming request TODO notify
					req.user.partner = target;
					user_obj.partner = req.user.id;
					req.user.timeline = user_obj.timeline = uuid.v4();
					delete user_obj.request;
					delete user_obj.incoming;
					delete req.user.request;
					delete req.user.incoming;					
				} else {
					// TODO turn down existing incoming request						
					req.user.incoming = false;
					req.user.request = target;
					user_obj.incoming = true;
					user_obj.request = req.user.id;					
				}
				
				redis.mset(
					'user:' + user_obj.id, JSON.stringify(user_obj),
					'user:' + req.user.id, JSON.stringify(req.user),
					function(err, redis_res){
					if (err) {
						res.json(500, {msg:'Internal error'});
						return;
					}
					
					// notify the other user about the change
					if (user_obj.device_token) {
						var payload = {
							type:'pair',
							user:user_obj.response()
						}
						user_obj.notify(req.user.id + " wants to share with you", 1, payload);
					} else {
						console.log(user_obj.id + ' doesn\'t yet have device token');
					}
				
					var response_obj = req.user.response();
					res.json(200, response_obj);						
				});
			});
		} 
	});
	
	// param: timestamp
	app.get('/api/timeline', function(req,res){
		redis.zrangebyscore('timeline:' + req.user.timeline, 
			req.param('timestamp'), '+inf', function(err,result){
				if (err) {
					res.json(500, {msg:'Internal error'});
					return;
				}
				res.json(200, {data:result});
		});
	});

	app.get('/api/entry', function(req,res){
		var timestamp = req.param('timestamp');
		req.user.fetch_single_entry(timestamp, function (entry){
			if (entry) {
				res.json(200, entry);
			} else {
				res.json(500);
			}
		});
	});

	app.get('/api/image/:id', function(req,res){
		redis.get('image:' + req.param('id'), function(err,obj){
			if (err) {
				res.json(500, {msg:'Internal error'});
				return;
			}
			if (!obj) {
				res.json(500, {msg:'Image doesn\'t exist'});
				return;
			}
			
			var post = JSON.parse(obj);
			if (post.timeline && post.timeline == req.user.timeline) {
				res.type(post.type);
				res.sendfile(post.path);
			} else {
				res.json(500, {msg:'No access'});
			}
		});
	});

	function create_image_store(timeline, image_width, image_height, image_attachment) {
		var image_id = uuid.v4();
		var image_store = {
			id:image_id,
			timeline:timeline,
			size:image_attachment.size,
			path:image_attachment.path,
			type:image_attachment.type
		};
		
		var image_info = {
			url:'api/image/' + image_id,
			width:image_width,
			height:image_height
		};
		return [image_store, image_info];
	}
	
	function create_subentry(image_info) {
		var sub_entry = {
			image:image_info
			// TODO text emotion location etc		
		};
		
		return sub_entry;
	}
	
	app.post('/api/reply-entry', function(req, res){
		var timestamp = req.param('timestamp');
		req.user.fetch_single_entry(timestamp, function (entry){
			if (entry) {
				// TODO check expiry
				
				var image_width = req.param('width');
				var image_height = req.param('height');
				
				var result = create_image_store(req.user.timeline, image_width, image_height, req.files.image);
				var image_store = result[0], image_info = result[1];
				
				var sub_entry = create_subentry(image_info);
				entry.subentry2 = sub_entry;
				
				var multi = redis.multi();
				multi.set('image:' + image_store.id, JSON.stringify(image_store));
				multi.zremrangebyscore('timeline:' + req.user.timeline, entry.time, entry.time); // TODO shouldn't be needed
				multi.zadd('timeline:' + req.user.timeline, entry.time, JSON.stringify(entry));
				multi.exec(function(err,obj){
					if (err) {
						res.json(500, {msg:'Internal error'});
						return;
					}
		
					console.log('Reply entry, ' + JSON.stringify(entry));
					res.json(200, entry);
					req.partner.notify(req.user.id + ' replied your picture', 1, {
						type:'reply',
						entry_timestamp:entry.time
						// TODO meta infomation, emotion, text
					});
				});
			} else {
				res.json(500, {msg:"Couldn't find entry with timestamp " + timestamp});
			}
		});
	});

	app.post('/api/new-entry', function(req, res){
		if (req.files == undefined ||
			req.files.image == undefined) {
			res.json(500, {msg:'No damn image??'});
			return;
		} 
		if (!req.user.timeline) {
			res.json(500, {msg:'Pair first to have a timeline'});
			return;
		}

		// Used by client to uniqeuly identify an entry before timestamp is known
		var entry_id = req.param('id');
		var image_width = req.param('width');
		var image_height = req.param('height');
		var is_solo = req.param('solo') == '1';
	
		var result = create_image_store(req.user.timeline, image_width, image_height, req.files.image);
		var image_store = result[0], image_info = result[1];
		
		var sub_entry = create_subentry(image_info);
			
		var entry = {
			id:entry_id,
			subentry1:sub_entry,
			time:new Date().getTime(),
			expire:new Date().getTime() + ACTIVE_TIMEOUT,
			solo:is_solo,
		};
		
		var multi = redis.multi();
	
		multi.set('image:' + image_store.id, JSON.stringify(image_store));
		multi.zadd('timeline:' + req.user.timeline, entry.time, JSON.stringify(entry));
	
		multi.exec(function(err,obj){
			if (err) {
				res.json(500, {msg:'Internal error'});
				return;
			}
		
			res.json(200, entry);
			req.partner.notify(req.user.id + ' took a picture', 1, {
				type:'post'
			});
		});			
	});		
	
	app.post('/api/synctoken', function(req, res) {
		
		var token = req.param('token');
		var user_id = req.user.id;
		req.user.device_token = token;

		console.log('/api/synctoken. user:' + req.user.id + ' Token:' + token + ' Len:' + (new Buffer(token, 'base64')).length);

		// TODO remove the old token association
		var multi = redis.multi();
					
		multi.set('user:' + user_id, JSON.stringify(req.user));
		if (token) {
			multi.set('token:' + token, user_id);
		}
		
		multi.exec(function (err, replies) {
			if (err) {
				res.json(500, {msg:'Internal error'});
				return;
			}
			
		    res.json(200);
			
		});
	});
}

var port = command_line.p || 80;
console.log('Listening at port ' + command_line.p);
app.listen(port);