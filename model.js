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

var apn, redis;

exports.init = function(apn_, redis_) {
	apn = apn_;
	redis = redis_;
}

// exports.create_entry = function(params) {
// 	var entry = params;
// 	entry.
// }

exports.create_user = function(json) {
	var user = JSON.parse(json);
	
	// notify function
	user.notify = function(text, badge, payload, expiry) {
		if (this.device_token) {
		    var note = new apn.apn.notification();
		    note.setAlertText(text);
		    note.badge = badge;
			note.payload = payload;
			//note.expiry = expiry; TODO error
			console.log('Send notification to ' + this.id + ' Content:' + JSON.stringify(note) + ' token:' + this.device_token);
			
			var token = new Buffer(this.device_token, 'base64');
		    apn.connection.pushNotification(note, token);			
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
	
	user.fetch_single_entry = function(timestamp, callback) {
		redis.zrangebyscore('timeline:' + this.timeline, timestamp, timestamp, function(err,result){
				if (err || !result) {
					callback();
				} else {
					var obj = JSON.parse(result);
					callback(obj);
				}
		});
	}
	
	return user;
};

exports.create_timeline_entry = function(json) {
	var entry = JSON.parse(json);
	
}
