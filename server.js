var express = require('express')
var app = express()

app.use(express.logger());
app.use(express.cookieParser());
app.use(express.bodyParser({keepExtensions: true, uploadDir:'./'}));

var uuid = require('node-uuid');
var redis = require('redis-url').connect(process.env.REDISTOGO_URL);
var session={};

// Apple Push Notification
var apn = require('apn');
var options = { 
	"gateway": "gateway.sandbox.push.apple.com",
	'cert': "cert.pem",
	"key": "key.pem"
};

var apnConnection = new apn.Connection(options);

apnConnection.on('connected', function() {
    console.log("APN Connected");
});	

apnConnection.on('transmitted', function(notification, device) {
    console.log("Notification transmitted to:" + device.token.toString('base64'));
});

apnConnection.on('transmissionError', function(errCode, notification, device) {
    console.error("Notification caused error: " + errCode + " for device ", device, notification);
});

apnConnection.on('timeout', function () {
    console.log("Connection Timeout");
});

apnConnection.on('disconnected', function() {
    console.log("Disconnected from APNS");
});

apnConnection.on('socketError', console.error);


// Redis
redis.on("error", function (err) {
    console.log(err);
});

redis.on("ready", function () {
	// TODO called multiple times
    console.log("Redis ready!");
	main();
});

// User
/*
id:user,
pass:pwd,
male:true,
partner:undefined,
request:undefined,
incoming:undefined, // true/false
device_token:undefined
*/
function parse_user(json) {
	var user = JSON.parse(json);
	
	// notify function
	user.notify = function(text, badge, payload) {
		if (this.device_token) {
			console.log('Send notification to ' + this.id);
		    var note = new apn.notification();
		    note.setAlertText(text);
		    note.badge = badge;
			note.payload = payload;
			var token = new Buffer(this.device_token, 'base64');
		    apnConnection.pushNotification(note, token);			
		}
	}

	user.response = function() {
		var obj = {
			partner:this.partner,
			request:this.request,
			incoming:this.incoming
		};
		return obj;
	}
	return user;
}

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
		req.user = parse_user(user_obj);
		//console.log('Authenticated user: ' + user_obj);
		next();
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

			var user_obj = parse_user(JSON.stringify({
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
			var user_obj = parse_user(obj);
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
				var user_obj = parse_user(user_str);
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

	app.get('/api/image/:id', function(req,res){
		redis.get('post:' + req.param('id'), function(err,obj){
			if (err) {
				res.json(500, {msg:'Internal error'});
				return;
			}
			if (!obj) {
				res.json(500, {msg:'Image doesn\'t exist'});
			} else {
				var post = JSON.parse(obj);
				if (post.timeline && post.timeline == req.user.timeline) {
					res.type(post.image.type).attachment(post.image.name);
					res.sendfile(post.image.path);
				} else {
					res.json(500, {msg:'No access'});
				}
			}
		});
	});

	app.post('/api/image', function(req, res){
		if (req.files == undefined ||
			req.files.image == undefined) {
			res.json(500, {msg:'No damn image??'});
			return;
		} 
		if (!req.user.timeline) {
			res.json(500, {msg:'Pair first to have a timeline'});
			return;
		}

		// store image 
		var id = uuid.v4();
		var timestamp = new Date().getTime();
		var post = {
			timeline:req.user.timeline,
			image:req.files.image
		};
		
		// TODO Parse images
		var entry = {
			id:id,
			url:'api/image/' + id,
			width:req.param('width'),
			height:req.param('height'),
			time:timestamp
		};

		var multi = redis.multi();
		
		multi.set('post:' + id, JSON.stringify(post));
		multi.zadd('timeline:' + req.user.timeline, entry.time, JSON.stringify(entry));
		
		multi.exec(function(err,obj){
			if (err) {
				res.json(500, {msg:'Internal error'});
				return;
			}
			
			res.json(200, {content:entry});
			// notify client						
			redis.get('user:' + req.user.partner, function(err, obj){
				if (obj) {
					var partner = parse_user(obj);
					partner.notify(req.user.id + ' took a picture', 1, {
						type:'post'
					});
				}
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


app.listen(80)