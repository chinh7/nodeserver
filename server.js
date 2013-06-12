var express = require('express')
var app = express()
app.use(express.cookieParser());
app.use(express.bodyParser({uploadDir:'./'}));

var uuid = require('node-uuid');

var redis = require("redis"),
    client = redis.createClient();

var session={};
	
// Redis
client.on("error", function (err) {
    console.log("Error " + err);
});

client.on("ready", function () {
    console.log("Redis ready! Server running.");
	main();
});

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
	client.get('user:' + user, function(err,user_obj){
		if (err || !user_obj) {
			res.json(500, {msg:err});
			return;
		}
		req.user = JSON.parse(user_obj);
		console.log('Authenticated user: ' + user_obj);
		next();		
	});
}

function user_response(user) {
	var obj = {
		partner:user.partner,
		request:user.request,
		incoming:user.incoming
	};
	return obj;
}

function main() {
	app.all('/api/*', requireAuthentication);
	
	app.get('/api/dump', function(req, res){
		res.send(200, JSON.stringify(req.user));
		//TODO dump timeline
	});
	
	app.post('/signup', function(req, res) {
		console.log('/signup/' + req.params);
	
		var user = req.param('user');
		var pwd = req.param('pwd');
		client.get('user:' + user, function(err,obj){
			if (err) {
				console.log('signup read error' + err);
				res.status(500).json({msg:err});
				return;
			}
			
			if (obj){
				console.log('User exists');
				res.status(500).json({msg: "User already exists"});
				return;
			}

			var user_obj = {
				id:user,
				pass:pwd,
				male:true,
				partner:undefined,
				request:undefined,
				incoming:undefined // true/false
			}; // refactor out
			
			client.set('user:' + user, JSON.stringify(user_obj),
				function(err, redis_res){
					if (err) {
						console.log('signup write error');
						res.status(500).json({msg:'internal error'});
					}
					else {
						res.status(200).json({msg:user_obj});
					}
				}
			);
		});
	});
	
	app.post('/signin', function(req, res){
		var user = req.param('user');
		var pwd = req.param('pwd');
		client.get('user:' + user, function(err,obj){
			if (err != null || obj == null) {
				res.status(500).json({msg:'User not existent'});	
				return;		
			}
			var user_obj = JSON.parse(obj);
   			if (user_obj.pass == pwd) {
   				var auth_id = uuid.v4();
   				session[user] = auth_id;
   				res.cookie('user', user);
   				res.cookie('auth_id', auth_id);
   				res.json(200, user_response(user_obj));
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
			client.get('user:' + target, function(err,user_str){
				if (err || !user_str) {
					res.json(500, {msg:'Invalid user id:' + target});
					return;
				}
				var user_obj = JSON.parse(user_str);
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
				
				client.mset(
					'user:' + user_obj.id, JSON.stringify(user_obj),
					'user:' + req.user.id, JSON.stringify(req.user),
					function(err, redis_res){
					if (err) {
						res.json(500, {msg:'Internal error, faild to write database'});
						return;
					}
					
					var response_obj = user_response(req.user);
					// TODO notify the other user about the change
					res.json(200, response_obj);						
				});
			});
		} 
	});
	
	app.get('/api/timeline/:timestamp', function(req,res){
		client.zrangebyscore('timeline:' + req.user.timeline, 
			req.param('timestamp'), '+inf', function(err,result){
				if (err) {
					res.json(500, {msg:'Internal error'});
					return;
				}
				res.json(200, result);
		});
	});

	app.get('/api/image/:id', function(req,res){
		client.get('post:' + req.param('id'), function(err,obj){
			if (err) {
				res.json(500, {msg:'Internal error'});
				return;
			}
			if (!obj) {
				res.json(500, {msg:'Image doesn\'t exist'});
			} else {
				var post = JSON.parse(obj);
				if (post.timeline && post.timeline == req.user.timeline) {
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
		
		client.set('post:' + id, JSON.stringify(post), function(err,obj){
			if (err) {
				res.json(500, {msg:'Failed to save post'});
				return;
			}
			
			var entry = {
				id:id,
				url:'api/image/' + id,
				width:0,
				height:0,
				time:timestamp
			};
						
			client.zadd('timeline:' + req.user.timeline, entry.time, JSON.stringify(entry),
				function(err,obj){
				if (err) {
					res.json(500, {msg:'Failed to save post in timeline'});
					return;
				}
				
				res.json(200, {msg:'OK', name:req.files.image.name});
				// notify client						
				
			});
		});
	});
}


app.listen(80)