const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({

  username:{
    type:String,
    required:true,
    unique:true,
    trim:true
  },

  email:{
    type:String,
    required:true,
    unique:true,
    lowercase:true
  },

  phone:{
    type:String,
    default:""
  },

  password:{
    type:String,
    required:true
  },

  role:{
    type:String,
    default:"FREE"
  },

  subscription:{
    type:String,
    default:"FREE"
  },

  subscriptionExpiry:{
    type:Date,
    default:null
  },

  emailVerified:{
    type:Boolean,
    default:false
  },

  createdAt:{
    type:Date,
    default:Date.now
  }

});

module.exports = mongoose.model("User",UserSchema);
